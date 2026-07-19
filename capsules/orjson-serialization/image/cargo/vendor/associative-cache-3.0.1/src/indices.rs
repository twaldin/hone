//! Various kinds of associativity and `Indices` implementations.

use super::{Capacity, Indices};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::marker::PhantomData;
use std::ops::Range;

#[inline]
fn hash_to_usize<H>(mut hasher: impl Hasher, h: &H) -> usize
where
    H: ?Sized + Hash,
{
    h.hash(&mut hasher);
    hasher.finish() as usize
}

macro_rules! define_hash_n_way {
    ( $( $( #[$attr:meta] )* $name:ident => $n:expr; )* ) => { $(
        $( #[ $attr ] )*
        #[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name<H = DefaultHasher> {
            _hasher: PhantomData<H>,
        }

        impl<T, C, H> Indices<T, C> for $name<H>
        where
            T: ?Sized + Hash,
            C: Capacity,
            H: Hasher + Default,
        {
            type Indices = Range<usize>;

            #[inline]
            fn indices(key: &T) -> Self::Indices {
                assert!(C::CAPACITY >= $n);
                let hasher = H::default();
                let base = hash_to_usize(hasher, key) % (C::CAPACITY / $n) * $n;
                base..base + $n
            }
        }
    )* }
}

define_hash_n_way! {
    /// Direct-mapped (i.e. one-way associative) caching based on the key's
    /// `Hash` implementation.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    HashDirectMapped => 1;
    /// Two-way set associative caching based on the key's `Hash`
    /// implementation.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    HashTwoWay => 2;
    /// Four-way set associative caching based on the key's `Hash`
    /// implementation.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    HashFourWay => 4;
    /// Eight-way set associative caching based on the key's `Hash`
    /// implementation.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    HashEightWay => 8;
    /// Sixteen-way set associative caching based on the key's `Hash`
    /// implementation.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    HashSixteenWay => 16;
    /// 32-way set associative caching based on the key's `Hash` implementation.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    HashThirtyTwoWay => 32;
}

macro_rules! define_pointer_n_way {
    ( $( $( #[$attr:meta] )* $name: ident => $n:expr; )* ) => {
        $(
            $( #[$attr] )*
            #[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
            pub struct $name;

            impl<T, C> Indices<*mut T, C> for $name
            where
                C: Capacity
            {
                type Indices = Range<usize>;

                #[inline]
                fn indices(&ptr: &*mut T) -> Self::Indices {
                    assert!(C::CAPACITY >= $n);

                    let ptr = ptr as usize;

                    // The bottom bits of the pointer are all zero because of
                    // alignment, so get rid of them. The compiler should be
                    // able to clean up this divide into a right shift because
                    // of the constant, power-of-two divisor.
                    let i = ptr / std::mem::align_of::<T>();

                    let base = i % (C::CAPACITY / $n) * $n;
                    base..(base + $n)
                }
            }

            impl<T, C> Indices<*const T, C> for $name
            where
                C: Capacity
            {
                type Indices = <Self as Indices<*mut T, C>>::Indices;

                #[inline]
                fn indices(&ptr: &*const T) -> Self::Indices {
                    <Self as Indices<*mut T, C>>::indices(&(ptr as *mut T))
                }
            }
        )*
    };
}

define_pointer_n_way! {
    /// Direct-mapped (i.e. one-way associative) caching based on the key's
    /// pointer value.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    PointerDirectMapped => 1;
    /// Two-way set associative caching based on the key's pointer value.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    PointerTwoWay => 2;
    /// Four-way set associative caching based on the key's pointer value.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    PointerFourWay => 4;
    /// Eight-way set associative caching based on the key's pointer value.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    PointerEightWay => 8;
    /// Sixteen-way set associative caching based on the key's pointer value.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    PointerSixteenWay => 16;
    /// 32-way set associative caching based on the key's pointer value.
    ///
    /// See the `Indices` trait's documentation for more on associativity.
    PointerThirtyTwoWay => 32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Capacity4;

    #[test]
    fn pointer_direct_mapped() {
        assert_eq!(
            <PointerDirectMapped as Indices<*mut u64, Capacity4>>::indices(&(0 as *mut u64)),
            0..1
        );
        assert_eq!(
            <PointerDirectMapped as Indices<*mut u64, Capacity4>>::indices(&(8 as *mut u64)),
            1..2
        );
        assert_eq!(
            <PointerDirectMapped as Indices<*mut u64, Capacity4>>::indices(&(16 as *mut u64)),
            2..3
        );
        assert_eq!(
            <PointerDirectMapped as Indices<*mut u64, Capacity4>>::indices(&(24 as *mut u64)),
            3..4
        );
        assert_eq!(
            <PointerDirectMapped as Indices<*mut u64, Capacity4>>::indices(&(32 as *mut u64)),
            0..1
        );
    }

    #[test]
    fn pointer_two_way() {
        assert_eq!(
            <PointerTwoWay as Indices<*mut u64, Capacity4>>::indices(&(0 as *mut u64)),
            0..2
        );
        assert_eq!(
            <PointerTwoWay as Indices<*mut u64, Capacity4>>::indices(&(8 as *mut u64)),
            2..4
        );
        assert_eq!(
            <PointerTwoWay as Indices<*mut u64, Capacity4>>::indices(&(16 as *mut u64)),
            0..2
        );
        assert_eq!(
            <PointerTwoWay as Indices<*mut u64, Capacity4>>::indices(&(24 as *mut u64)),
            2..4
        );
        assert_eq!(
            <PointerTwoWay as Indices<*mut u64, Capacity4>>::indices(&(32 as *mut u64)),
            0..2
        );
    }
}
