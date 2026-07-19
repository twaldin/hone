//! fork from <https://github.com/indexmap-rs/equivalent/blob/v1.0.2/src/lib.rs>

use core::hash::Hash;
use core::cmp::Ordering;
use core::borrow::Borrow;
use crate::phf::HashOne;

/// Key equivalence trait.
///
/// This trait allows hash table lookup to be customized. It has one blanket
/// implementation that uses the regular solution with `Borrow` and `Eq`, just
/// like `HashMap` does, so that you can pass `&str` to lookup into a map with
/// `String` keys and so on.
///
/// # Contract
///
/// The implementor **must** hash like `K`, if it is hashable.
pub trait Equivalent<K: ?Sized> {
    /// Compare self to `key` and return `true` if they are equal.
    fn equivalent(&self, key: &K) -> bool;
}

impl<Q: ?Sized, K: ?Sized> Equivalent<K> for Q
where
    Q: Eq,
    K: Borrow<Q>,
{
    #[inline]
    fn equivalent(&self, key: &K) -> bool {
        PartialEq::eq(self, key.borrow())
    }
}

/// Key ordering trait.
///
/// This trait allows ordered map lookup to be customized. It has one blanket
/// implementation that uses the regular solution with `Borrow` and `Ord`, just
/// like `BTreeMap` does, so that you can pass `&str` to lookup into a map with
/// `String` keys and so on.
pub trait Comparable<K: ?Sized>: Equivalent<K> {
    /// Compare self to `key` and return their ordering.
    fn compare(&self, key: &K) -> Ordering;
}

impl<Q: ?Sized, K: ?Sized> Comparable<K> for Q
where
    Q: Ord,
    K: Borrow<Q>,
{
    #[inline]
    fn compare(&self, key: &K) -> Ordering {
        Ord::cmp(self, key.borrow())
    }
}

/// Hashable trait.
pub trait Hashable<H: HashOne> {
    fn hash(&self, seed: u64) -> u64;
}

impl<T: Hash + ?Sized, H: HashOne> Hashable<H> for T {
    fn hash(&self, seed: u64) -> u64 {
        H::hash_one(seed, self)
    }
}
