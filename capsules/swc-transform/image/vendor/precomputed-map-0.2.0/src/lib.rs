#![cfg_attr(not(feature = "builder"), no_std)]
#![doc = include_str!("../README.md")]

#[cfg(feature = "builder")]
pub mod builder;
pub mod phf;

mod macros;
pub mod equivalent;
pub mod seq;
pub mod store;
pub mod aligned;

use core::marker::PhantomData;
use phf::HashOne;
use equivalent::{ Equivalent, Comparable, Hashable };


/// Tiny map
///
/// 0..16
pub struct TinyMap<M> {
    _phantom: PhantomData<M>
}

impl<M: store::Searchable> TinyMap<M> {
    #[doc(hidden)]
    #[allow(clippy::new_without_default)]
    pub const fn new() -> TinyMap<M> {
        TinyMap { _phantom: PhantomData }
    }

    pub const fn len(&self) -> usize {
        M::LEN
    }

    pub const fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get<Q>(&self, key: &Q)
        -> Option<M::Value>
    where
        Q: Comparable<M::Key> + ?Sized
    {
        let idx = M::search(key)?;
        M::get_value(idx)
    }

    pub const fn iter(&self) -> store::MapIter<'_, M> {
        store::MapIter::new()
    }
}

/// Small map
///
/// 0..12
pub struct SmallMap<D, H> {
    seed: u64,
    _phantom: PhantomData<(D, H)>
}

impl<D, H> SmallMap<D, H>
where
    D: store::MapStore,
    H: HashOne,
{
    #[doc(hidden)]
    pub const fn new(seed: u64) -> Self {
        SmallMap {
            seed,
            _phantom: PhantomData
        }
    }

    pub const fn len(&self) -> usize {
        D::LEN
    }    

    pub const fn is_empty(&self) -> bool {
        self.len() == 0
    }
    
    #[inline]
    fn inner_get<Q>(&self, key: &Q) -> usize
    where
        Q: Hashable<H> + ?Sized,
    {
        let size: u32 = D::LEN.try_into().unwrap();

        let hash = key.hash(self.seed);
        let index = fast_reduct32(high(hash) ^ low(hash), size);
        index.try_into().unwrap()
    }

    pub fn get<Q>(&self, key: &Q) -> Option<D::Value>
    where
        Q: Equivalent<D::Key> + Hashable<H> + ?Sized,
    {
        if self.is_empty() {
            return None;
        }
        
        let index = self.inner_get(key);
        if key.equivalent(&D::get_key(index)?) {
            D::get_value(index)
        } else {
            None
        }
    }

    pub const fn iter(&self) -> store::MapIter<'_, D> {
        store::MapIter::new()
    }    
}

/// Medium map
///
/// 1024..10M
pub struct MediumMap<
    P,
    R,
    D,
    H,
> {
    seed: u64,
    _phantom: PhantomData<(
        P, R, D, H
    )>
}

impl<
    P,
    R,
    D,
    H,
> MediumMap<P, R, D, H>
where
    P: store::AccessSeq<Item = u8>,
    R: store::AccessSeq<Item = u32>,
    D: store::MapStore,
    H: HashOne
{
    #[doc(hidden)]
    pub const fn new(seed: u64) -> Self {
        MediumMap {
            seed,
            _phantom: PhantomData
        }
    }

    pub const fn len(&self) -> usize {
        D::LEN
    }    

    pub const fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[inline]    
    fn inner_get<Q>(&self, key: &Q) -> usize
    where
        Q: Hashable<H> + ?Sized,
    {
        let pilots_len: u32 = P::LEN.try_into().unwrap();
        let slots_len: u32 = (D::LEN + R::LEN).try_into().unwrap();

        let hash = key.hash(self.seed);
        let bucket: usize = fast_reduct32(low(hash), pilots_len).try_into().unwrap();
        let pilot = P::index(bucket).unwrap();
        let pilot_hash = phf::hash_pilot(self.seed, pilot);

        fast_reduct32(
            high(hash) ^ high(pilot_hash) ^ low(pilot_hash),
            slots_len
        ).try_into().unwrap()
    }

    pub fn get<Q>(&self, key: &Q) -> Option<D::Value>
    where
        Q: Equivalent<D::Key> + Hashable<H> + ?Sized,
    {
        #[cold]
        #[inline(always)]
        fn remap_and_index<R, D, Q>(index: usize, key: &Q)
        -> Option<D::Value>
        where
            R: store::AccessSeq<Item = u32>,
            D: store::MapStore,
            Q: Equivalent<D::Key> + ?Sized,
        {
            let index: usize = R::index(index - D::LEN).unwrap().try_into().unwrap();
            if key.equivalent(&D::get_key(index)?) {
                D::get_value(index)
            } else {
                None
            }
        }
                
        if self.is_empty() {
            return None;
        }
        
        let index = self.inner_get(key);

        if index < D::LEN {
            if key.equivalent(&D::get_key(index)?) {
                D::get_value(index)
            } else {
                None
            }
        } else {
            remap_and_index::<R, D, Q>(index, key)
        }
    }

    pub const fn iter(&self) -> store::MapIter<'_, D> {
        store::MapIter::new()
    }
}

// https://lemire.me/blog/2016/06/27/a-fast-alternative-to-the-modulo-reduction/
#[inline]
fn fast_reduct32(x: u32, limit: u32) -> u32 {
    (((x as u64) * (limit as u64)) >> 32) as u32
}

#[inline]
fn low(v: u64) -> u32 {
    v as u32
}

#[inline]
fn high(v: u64) -> u32 {
    (v >> 32) as u32
}
