use core::marker::PhantomData;
use crate::equivalent::Comparable;

pub trait AsData {
    type Data: ?Sized;
    
    fn as_data() -> &'static Self::Data;
}

pub trait AccessSeq {
    type Item;
    const LEN: usize;

    fn index(index: usize) -> Option<Self::Item>;
}

pub trait Searchable: MapStore {
    fn search<Q>(query: &Q) -> Option<usize>
    where
        Q: Comparable<Self::Key> + ?Sized;
}

pub trait MapStore {
    type Key;
    type Value;

    const LEN: usize;

    fn get_key(index: usize) -> Option<Self::Key>;
    fn get_value(index: usize) -> Option<Self::Value>;    
}

pub struct SliceData<
    const O: usize,
    const L: usize,
    D
>(PhantomData<([u8; O], [u8; L], D)>);

impl<
    const B: usize,
    const O: usize,
    const L: usize,
    D: AsData<Data = [u8; B]>
> AsData for SliceData<O, L, D> {
    type Data = [u8; L];

    #[inline(always)]
    fn as_data() -> &'static Self::Data {
        D::as_data()[O..][..L].try_into().unwrap()
    }
}

impl<const B: usize, D> AccessSeq for D
where
    D: AsData<Data = [u8; B]>
{
    type Item = u8;
    const LEN: usize = B;

    #[inline(always)]
    fn index(index: usize) -> Option<Self::Item> {
        D::as_data().get(index).copied()
    }
}

impl<K> MapStore for K
where
    K: AccessSeq
{
    type Key = K::Item;
    type Value = usize;

    const LEN: usize = K::LEN;

    #[inline(always)]
    fn get_key(index: usize) -> Option<Self::Key> {
        K::index(index)
    }

    #[inline(always)]
    fn get_value(index: usize) -> Option<Self::Value> {
        debug_assert!(index < Self::LEN);
        
        Some(index)
    }
}

impl<K, V> MapStore for (K, V)
where
    K: AccessSeq,
    V: AccessSeq
{
    type Key = K::Item;
    type Value = V::Item;

    const LEN: usize = {
        if K::LEN != V::LEN {
            panic!();
        }

        K::LEN
    };

    #[inline(always)]
    fn get_key(index: usize) -> Option<Self::Key> {
        K::index(index)
    }

    #[inline(always)]
    fn get_value(index: usize) -> Option<Self::Value> {
        V::index(index)
    }
}

impl<K, V> Searchable for (K, V)
where
    K: Searchable + AccessSeq,
    K: MapStore<Key = K::Item>,
    V: AccessSeq,
{
    fn search<Q>(query: &Q) -> Option<usize>
    where
        Q: Comparable<K::Item> + ?Sized
    {
        K::search(query)
    }
}

pub struct MapIter<'iter, D> {
    next: usize,
    _phantom: PhantomData<&'iter D>
}

impl<'iter, D> MapIter<'iter, D> {
    pub(super) const fn new() -> Self {
        MapIter { next: 0, _phantom: PhantomData }
    }
}

impl<'iter, D> Iterator for MapIter<'iter, D>
where
    D: MapStore
{
    type Item = (D::Key, D::Value);

    fn next(&mut self) -> Option<Self::Item> {
        if self.next < D::LEN {
            let k = D::get_key(self.next)?;
            let v = D::get_value(self.next)?;
            self.next += 1;
            Some((k, v))
        } else {
            None
        }
    }
}

impl<'iter, D> ExactSizeIterator for MapIter<'iter, D>
where
    D: MapStore
{
    fn len(&self) -> usize {
        D::LEN
    }
}

impl<'iter, D> Clone for MapIter<'iter, D> {
    #[inline]
    fn clone(&self) -> Self {
        MapIter {
            next: self.next,
            _phantom: PhantomData
        }
    }
}
