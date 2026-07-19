use core::{hint::unreachable_unchecked, marker::PhantomData};

use crate::{internal, Borrow, Destructure, Restructure};

pub fn make_destructurer<T: Destructure>(
    value: T,
) -> <T::Destructuring as internal::DestructuringFor<T>>::Destructurer
where
    T::Destructuring: internal::DestructuringFor<T>,
{
    internal::Destructurer::new(value)
}

pub fn destructurer_ptr<T: internal::Destructurer>(
    destructurer: &mut T,
) -> *mut <T::Inner as Destructure>::Underlying {
    Destructure::underlying(destructurer.inner_mut())
}

/// # Safety
///
/// `test_destructurer` may not be called.
pub fn test_destructurer<'a, T: internal::Test<'a>>(_: &'a mut T) -> T::Test {
    // SAFETY: `test_destructurer` may not be called.
    unsafe { unreachable_unchecked() }
}

/// # Safety
///
/// `ptr` must be a properly-aligned pointer to a subfield of the pointer
/// underlying the inner value of `destructurer`.
pub unsafe fn restructure_destructurer<T: internal::Destructurer, U>(
    destructurer: &T,
    ptr: *mut U,
) -> <T::Inner as Restructure<U>>::Restructured
where
    T::Inner: Restructure<U>,
{
    // SAFETY: The caller has guaranteed that `ptr` is a properly-aligned
    // pointer to a subfield of the pointer underlying the inner value of
    // `destructurer`.
    unsafe {
        Restructure::restructure(
            internal::Destructurer::inner(destructurer),
            ptr,
        )
    }
}

pub fn get_destructure<T>(_: &T) -> PhantomData<T::Inner>
where
    T: internal::Destructurer,
{
    PhantomData
}

pub fn only_borrow_destructuring_may_use_rest_patterns<
    T: Destructure<Destructuring = Borrow>,
>(
    _: PhantomData<T>,
) {
}
