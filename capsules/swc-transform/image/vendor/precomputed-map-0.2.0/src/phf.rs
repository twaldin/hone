use core::hash::{ Hash, Hasher };
use core::marker::PhantomData;

/// Hash with seed
pub trait HashOne {
    fn hash_one<T: Hash>(k: u64, v: T) -> u64;
}

pub(crate) fn hash_pilot(k: u64, pilot: u8) -> u64 {
    const C: u64 = 0x517cc1b727220a95;

    // fxhash
    C.wrapping_mul(k ^ u64::from(pilot))
}

#[derive(Default)]
pub struct U64Hasher<H: Hasher + Default>(PhantomData<H>);

impl<H: Hasher + Default> HashOne for U64Hasher<H> {
    fn hash_one<T: Hash>(k: u64, v: T) -> u64 {
        let mut h = H::default();
        h.write_u64(k);
        v.hash(&mut h);
        h.finish()
    }
}
