//! Shrink-to-fit trait for collections.
//!
//! This crate provides a `ShrinkToFit` trait that can be used to shrink-to-fit
//! collections.
//!
//! # Examples
//!
//! ```
//! use shrink_to_fit::ShrinkToFit;
//!
//! let mut vec = Vec::with_capacity(100);
//! vec.push(1);
//! vec.push(2);
//! vec.push(3);
//! vec.shrink_to_fit();
//! assert_eq!(vec.len(), 3);
//! assert_eq!(vec.capacity(), 3);
//! ```
#![deny(warnings)]
#![cfg_attr(docsrs, feature(doc_cfg))]

use std::{
    collections::{HashMap, HashSet, VecDeque},
    hash::{BuildHasher, Hash},
};

#[cfg(feature = "derive")]
#[cfg_attr(docsrs, doc(cfg(feature = "derive")))]
pub use shrink_to_fit_macro::ShrinkToFit;

/// Recursively calls `shrink_to_fit` on all elements of the container.
pub trait ShrinkToFit {
    fn shrink_to_fit(&mut self);
}

macro_rules! impl_noop {
    ($($t:ty),*) => {
        $(
            impl ShrinkToFit for $t {
                #[inline(always)]
                fn shrink_to_fit(&mut self) {}
            }
        )*
    };
}

impl_noop!(u8, u16, u32, u64, u128, i8, i16, i32, i64, i128, f32, f64);
impl_noop!(bool, char);

impl<T: ?Sized + ShrinkToFit> ShrinkToFit for &mut T {
    #[inline]
    fn shrink_to_fit(&mut self) {
        (**self).shrink_to_fit();
    }
}

impl<T: ?Sized + ShrinkToFit> ShrinkToFit for Box<T> {
    #[inline]
    fn shrink_to_fit(&mut self) {
        self.as_mut().shrink_to_fit();
    }
}

impl<T: ShrinkToFit> ShrinkToFit for Vec<T> {
    #[inline]
    fn shrink_to_fit(&mut self) {
        for value in self.iter_mut() {
            value.shrink_to_fit();
        }
        self.shrink_to_fit();
    }
}

impl ShrinkToFit for String {
    #[inline]
    fn shrink_to_fit(&mut self) {
        self.shrink_to_fit();
    }
}

impl<T: ShrinkToFit> ShrinkToFit for Option<T> {
    #[inline]
    fn shrink_to_fit(&mut self) {
        if let Some(value) = self {
            value.shrink_to_fit();
        }
    }
}

impl<K, V, S> ShrinkToFit for HashMap<K, V, S>
where
    K: Eq + Hash,
    S: BuildHasher,
{
    fn shrink_to_fit(&mut self) {
        self.shrink_to_fit();
    }
}

impl<K, S> ShrinkToFit for HashSet<K, S>
where
    K: Eq + Hash,
    S: BuildHasher,
{
    fn shrink_to_fit(&mut self) {
        self.shrink_to_fit();
    }
}

impl<T: ShrinkToFit> ShrinkToFit for VecDeque<T> {
    #[inline]
    fn shrink_to_fit(&mut self) {
        self.shrink_to_fit();
    }
}

#[cfg(feature = "indexmap")]
impl<K, V, S> ShrinkToFit for indexmap::IndexMap<K, V, S>
where
    K: Eq + Hash,
    S: BuildHasher,
{
    fn shrink_to_fit(&mut self) {
        self.shrink_to_fit();
    }
}

#[cfg(feature = "indexmap")]
impl<K, S> ShrinkToFit for indexmap::IndexSet<K, S>
where
    K: Eq + Hash,
    S: BuildHasher,
{
    fn shrink_to_fit(&mut self) {
        self.shrink_to_fit();
    }
}

#[cfg(feature = "hashbrown")]
impl<K, V, S> ShrinkToFit for hashbrown::HashMap<K, V, S>
where
    K: Eq + Hash,
    S: BuildHasher,
{
    fn shrink_to_fit(&mut self) {
        self.shrink_to_fit();
    }
}

#[cfg(feature = "hashbrown")]
impl<K, S> ShrinkToFit for hashbrown::HashSet<K, S>
where
    K: Eq + Hash,
    S: BuildHasher,
{
    fn shrink_to_fit(&mut self) {
        self.shrink_to_fit();
    }
}
