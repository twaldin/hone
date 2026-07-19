//! Write-only references and slices.
#![deny(
    missing_docs,
    clippy::all,
    clippy::cargo,
    clippy::missing_const_for_fn,
    clippy::missing_inline_in_public_items
)]
#![no_std]

use core::marker::PhantomData;
use core::mem::MaybeUninit;
use core::ptr::NonNull;

/// A write-only reference of `T`.
pub struct OutRef<'a, T> {
    data: NonNull<T>,
    _marker: PhantomData<&'a mut MaybeUninit<T>>,
}

unsafe impl<T: Send> Send for OutRef<'_, T> {}
unsafe impl<T: Sync> Sync for OutRef<'_, T> {}

impl<'a, T> OutRef<'a, T> {
    /// Forms an `OutRef<'a, T>`.
    ///
    /// # Safety
    ///
    /// Behavior is undefined if any of the following conditions are violated:
    ///
    /// * `data` must be valid for writes.
    ///
    /// * `data` must be properly aligned.
    #[inline(always)]
    pub unsafe fn from_raw(data: *mut T) -> Self {
        Self {
            data: NonNull::new_unchecked(data),
            _marker: PhantomData,
        }
    }

    /// Forms an `OutBuf` from an initialized value.
    #[inline(always)]
    pub fn new(val: &'a mut T) -> Self {
        let data: *mut T = val;
        unsafe { Self::from_raw(data) }
    }

    /// Forms an `OutBuf` from an uninitialized value.
    #[inline(always)]
    pub fn uninit(val: &'a mut MaybeUninit<T>) -> Self {
        let data: *mut T = MaybeUninit::as_mut_ptr(val);
        unsafe { Self::from_raw(data.cast()) }
    }

    /// Returns an unsafe mutable pointer to the value.
    #[inline(always)]
    pub fn as_mut_ptr(&mut self) -> *mut T {
        self.data.as_ptr().cast()
    }

    /// Sets the value of the `OutRef`.
    #[inline(always)]
    pub fn write(mut self, val: T) -> &'a mut T {
        unsafe {
            self.data.as_ptr().write(val);
            self.data.as_mut()
        }
    }
}

/// A write-only slice of `T`.
pub struct OutBuf<'a, T> {
    data: NonNull<MaybeUninit<T>>,
    len: usize,
    _marker: PhantomData<&'a mut [MaybeUninit<T>]>,
}

unsafe impl<T: Send> Send for OutBuf<'_, T> {}
unsafe impl<T: Sync> Sync for OutBuf<'_, T> {}

impl<'a, T> OutBuf<'a, T> {
    /// Forms an `OutBuf<'a, T>`
    ///
    /// # Safety
    ///
    /// Behavior is undefined if any of the following conditions are violated:
    ///
    /// * `data` must be `valid` for writes for `len * mem::size_of::<T>()` many bytes,
    ///   and it must be properly aligned. This means in particular:
    ///
    ///     * The entire memory range of this slice must be contained within a single allocated object!
    ///       Slices can never span across multiple allocated objects.
    ///     * `data` must be non-null and aligned even for zero-length slices. One
    ///       reason for this is that enum layout optimizations may rely on references
    ///       (including slices of any length) being aligned and non-null to distinguish
    ///       them from other data. You can obtain a pointer that is usable as `data`
    ///       for zero-length slices using `NonNull::dangling()`.
    ///
    /// * `data` must point to `len` consecutive places for type `T`.
    ///
    /// * The memory referenced by the returned slice must not be accessed through any other pointer
    ///   (not derived from the return value) for the duration of lifetime `'a`.
    ///   Both read and write accesses are forbidden.
    ///
    /// * The total size `len * mem::size_of::<T>()` of the slice must be no larger than `isize::MAX`.
    ///   See the safety documentation of `pointer::offset`.
    #[inline(always)]
    pub unsafe fn from_raw(data: *mut T, len: usize) -> Self {
        Self {
            data: NonNull::new_unchecked(data as *mut MaybeUninit<T>),
            len,
            _marker: PhantomData,
        }
    }

    /// Forms an `OutBuf` from an initialized slice.
    #[inline(always)]
    pub fn new(slice: &'a mut [T]) -> Self {
        let len = slice.len();
        let data = slice.as_mut_ptr();
        unsafe { Self::from_raw(data, len) }
    }

    /// Forms an `OutBuf` from an uninitialized slice.
    #[inline(always)]
    pub fn uninit(slice: &'a mut [MaybeUninit<T>]) -> Self {
        let len = slice.len();
        let data = slice.as_mut_ptr();
        unsafe { Self::from_raw(data.cast(), len) }
    }

    /// Returns true if the buffer has a length of 0.
    #[inline(always)]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Returns the number of elements in the buffer.
    #[inline(always)]
    pub const fn len(&self) -> usize {
        self.len
    }

    /// Returns an unsafe mutable pointer to the buffer.
    #[inline(always)]
    pub fn as_mut_ptr(&mut self) -> *mut T {
        self.data.as_ptr().cast()
    }
}
