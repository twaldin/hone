#![no_std]

//! cooked_waker provides safe traits for working with
//! [`std::task::Waker`][Waker] and creating those wakers out of regular, safe
//! Rust structs. It cooks `RawWaker` and `RawWakerVTable`, making them safe
//! for consumption.
//!
//! It provides the [`Wake`] and [`WakeRef`] traits, which correspond to the
//! [`wake`][Waker::wake] and [`wake_by_ref`][Waker::wake_by_ref] methods
//! on [`std::task::Waker`][Waker], and it provides implenetations of these
//! types for the common reference & pointer types (`Arc`, `Rc`, `&'static`,
//! etc).
//!
//! Additionally, it provides [`IntoWaker`], which allows converting any
//! `Wake + Clone` type into a [`Waker`]. This trait is automatically derived
//! for any `Wake + Clone + Send + Sync + 'static` type.
//!
//! # Basic example
//!
//! ```
//! use cooked_waker::{Wake, WakeRef, IntoWaker, ViaRawPointer};
//! use std::sync::atomic::{AtomicUsize, Ordering};
//! use std::task::Waker;
//!
//! static wake_ref_count: AtomicUsize = AtomicUsize::new(0);
//! static wake_value_count: AtomicUsize = AtomicUsize::new(0);
//! static drop_count: AtomicUsize = AtomicUsize::new(0);
//!
//! // A simple Waker struct that atomically increments the relevant static
//! // counters.
//! #[derive(Debug, Clone)]
//! struct StaticWaker;
//!
//! impl WakeRef for StaticWaker {
//!     fn wake_by_ref(&self) {
//!         wake_ref_count.fetch_add(1, Ordering::SeqCst);
//!     }
//! }
//!
//! impl Wake for StaticWaker {
//!     fn wake(self) {
//!         wake_value_count.fetch_add(1, Ordering::SeqCst);
//!     }
//! }
//!
//! impl Drop for StaticWaker {
//!     fn drop(&mut self) {
//!         drop_count.fetch_add(1, Ordering::SeqCst);
//!     }
//! }
//!
//! // Usually in practice you'll be using an Arc or Box, which already
//! // implement this, so there will be no need to implement it yourself.
//! unsafe impl ViaRawPointer for StaticWaker {
//!     type Target = ();
//!
//!     fn into_raw(self) -> *mut () {
//!         // Need to forget self because we're being converted into a pointer,
//!         // so destructors should not run.
//!         std::mem::forget(self);
//!         std::ptr::null_mut()
//!     }
//!
//!     unsafe fn from_raw(ptr: *mut ()) -> Self {
//!         StaticWaker
//!     }
//! }
//!
//! assert_eq!(drop_count.load(Ordering::SeqCst), 0);
//!
//! let waker = StaticWaker;
//! {
//!     let waker1: Waker = waker.into_waker();
//!
//!     waker1.wake_by_ref();
//!     assert_eq!(wake_ref_count.load(Ordering::SeqCst), 1);
//!
//!     let waker2: Waker = waker1.clone();
//!     waker2.wake_by_ref();
//!     assert_eq!(wake_ref_count.load(Ordering::SeqCst), 2);
//!
//!     waker1.wake();
//!     assert_eq!(wake_value_count.load(Ordering::SeqCst), 1);
//!     assert_eq!(drop_count.load(Ordering::SeqCst), 1);
//! }
//! assert_eq!(drop_count.load(Ordering::SeqCst), 2);
//! ```
//!
//! # Arc example
//!
//! ```
//! use cooked_waker::{Wake, WakeRef, IntoWaker};
//! use std::sync::atomic::{AtomicUsize, Ordering};
//! use std::sync::Arc;
//! use std::task::Waker;
//!
//! // A simple struct that counts the number of times it is awoken. Can't
//! // be awoken by value (because that would discard the counter), so we
//! // must instead wrap it in an Arc.
//! #[derive(Debug, Default)]
//! struct Counter {
//!     // We use atomic usize because we need Send + Sync and also interior
//!     // mutability
//!     count: AtomicUsize,
//! }
//!
//! impl Counter {
//!     fn get(&self) -> usize {
//!         self.count.load(Ordering::SeqCst)
//!     }
//! }
//!
//! impl WakeRef for Counter {
//!     fn wake_by_ref(&self) {
//!         let _prev = self.count.fetch_add(1, Ordering::SeqCst);
//!     }
//! }
//!
//! let counter_handle = Arc::new(Counter::default());
//!
//! // Create an std::task::Waker
//! let waker: Waker = counter_handle.clone().into_waker();
//!
//! waker.wake_by_ref();
//! waker.wake_by_ref();
//!
//! let waker2 = waker.clone();
//! waker2.wake_by_ref();
//!
//! // Because IntoWaker wrap the pointer directly, without additional
//! // boxing, we can use will_wake
//! assert!(waker.will_wake(&waker2));
//!
//! // This calls Counter::wake_by_ref because the Arc doesn't have exclusive
//! // ownership of the underlying Counter
//! waker2.wake();
//!
//! assert_eq!(counter_handle.get(), 4);
//! ```

extern crate alloc;

use alloc::boxed::Box;
use alloc::rc;
use alloc::sync as arc;
use core::{
    mem::ManuallyDrop,
    ptr,
    task::{RawWaker, RawWakerVTable, Waker},
};

/// Trait for types that can be converted into raw pointers and back again.
///
/// # Safety
///
/// - Implementors must ensure that, for a given object, the pointer remains
///   fixed as long as no mutable operations are performed (that is, calling
///   from_ptr() followed by into_ptr(), with no mutable operations in between,
///   the returned pointer has the same value.)
/// - Implementors also must not panic when the interface is used correctly.
///   The Waker constructed by IntoWaker can cause a double drop if either of
///   these functions panic.
///
/// In the future, we hope to have a similar trait added to the standard
/// library; see https://github.com/rust-lang/rust/issues/75846 for details.
pub unsafe trait ViaRawPointer {
    type Target: ?Sized;

    /// Convert this object into a raw pointer.
    fn into_raw(self) -> *mut Self::Target;

    /// Convert a raw pointer back into this object.
    ///
    /// # Safety
    ///
    /// This method must ONLY be called on a pointer that was received via
    /// `Self::into_raw`, and that pointer must not be used afterwards.
    unsafe fn from_raw(ptr: *mut Self::Target) -> Self;
}

/// Wakers that can wake by reference. This trait is used to enable a [`Wake`]
/// implementation for types that don't own an underlying handle, like `Arc<T>`
/// and `&T`.
///
/// This trait is implemented for most container and reference types, like
/// `&T where T: WakeRef`, `Box<T: WakeRef>`, and `Arc<T: WakeRef>`.
pub trait WakeRef {
    /// Wake up the task by reference. In general [`Wake::wake`] should be
    /// preferred, if available, as it's probably more efficient.
    ///
    /// A [`Waker`] created by [`IntoWaker`] will call this method through
    /// [`Waker::wake_by_ref`].
    fn wake_by_ref(&self);
}

/// Wakers that can wake by value. This is the primary means of waking a task.
///
/// This trait is implemented for most container types, like `Box<T: Wake>`
/// and `Option<T: Wake>`. It is also implemented for shared pointer types like
/// `Arc<T>` and `&T`, but those implementations call `T::wake_by_ref`, because
/// they don't have ownership of the underlying `T`.
pub trait Wake: WakeRef + Sized {
    /// Wake up the task by value. By default, this simply calls
    /// [`WakeRef::wake_by_ref`].
    ///
    /// A [`Waker`] created by [`IntoWaker`] will call this method through
    /// [`Waker::wake`].
    #[inline]
    fn wake(self) {
        self.wake_by_ref()
    }
}

/// Objects that can be converted into an [`Waker`]. This trait is
/// automatically implemented for types that fulfill the waker interface.
/// Such types must be:
/// - [`Clone`]
/// - `Send + Sync`
/// - `'static`
/// - [`Wake`]
/// - [`ViaRawPointer`]
///
/// The implementation of this trait sets up a [`RawWakerVTable`] for the type,
/// and arranges a conversion into a [`Waker`] through the [`ViaRawPointer`]
/// trait, which should be implemented for types that be converted to and from
/// pointers. This trait is implemented for all the standard library pointer
/// types (such as `Arc` and `Box`), and you can implement it on your own types
/// if you want to use them for wakers.
///
/// It should never be necessary to implement this trait manually.
///
/// [`RawWakerVTable`]: core::task::RawWakerVTable
/// [`Waker`]: core::task::Waker
/// [`Clone`]: core::clone::Clone
pub trait IntoWaker {
    /// The RawWakerVTable for this type. This should never be used directly;
    /// it is entirely handled by `into_waker`. It is present as an associated
    /// const because that's the only way for it to work in generic contexts.
    #[doc(hidden)]
    const VTABLE: &'static RawWakerVTable;

    /// Convert this object into a `Waker`.
    #[must_use]
    fn into_waker(self) -> Waker;
}

impl<T> IntoWaker for T
where
    T: Wake + Clone + Send + Sync + 'static + ViaRawPointer,
    T::Target: Sized,
{
    const VTABLE: &'static RawWakerVTable = &RawWakerVTable::new(
        // clone
        |raw| {
            let raw = raw as *mut T::Target;

            let waker = ManuallyDrop::<T>::new(unsafe { ViaRawPointer::from_raw(raw) });
            let cloned: T = (*waker).clone();

            // We can't save the `into_raw` back into the raw waker, so we must
            // simply assert that the pointer has remained the same. This is
            // part of the ViaRawPointer safety contract, so we only check it
            // in debug builds.
            debug_assert_eq!(ManuallyDrop::into_inner(waker).into_raw(), raw);

            let cloned_raw = cloned.into_raw();
            let cloned_raw = cloned_raw as *const ();
            RawWaker::new(cloned_raw, T::VTABLE)
        },
        // wake by value
        |raw| {
            let raw = raw as *mut T::Target;
            let waker: T = unsafe { ViaRawPointer::from_raw(raw) };
            waker.wake();
        },
        // wake by ref
        |raw| {
            let raw = raw as *mut T::Target;
            let waker = ManuallyDrop::<T>::new(unsafe { ViaRawPointer::from_raw(raw) });
            waker.wake_by_ref();

            debug_assert_eq!(ManuallyDrop::into_inner(waker).into_raw(), raw);
        },
        // Drop
        |raw| {
            let raw = raw as *mut T::Target;
            let _waker: T = unsafe { ViaRawPointer::from_raw(raw) };
        },
    );

    fn into_waker(self) -> Waker {
        let raw = self.into_raw();
        let raw = raw as *const ();
        let raw_waker = RawWaker::new(raw, T::VTABLE);
        unsafe { Waker::from_raw(raw_waker) }
    }
}

// Waker implementations for std types. Feel free to open PRs for additional
// stdlib types here.

// We'd prefer to implement WakeRef for T: Deref<Target=WakeRef>, but that
// results in type coherence issues with non-deref stdlib types.

impl<T: WakeRef + ?Sized> WakeRef for &T {
    #[inline]
    fn wake_by_ref(&self) {
        T::wake_by_ref(*self)
    }
}

impl<T: WakeRef + ?Sized> Wake for &T {}

unsafe impl<T: ?Sized> ViaRawPointer for Box<T> {
    type Target = T;

    fn into_raw(self) -> *mut T {
        Box::into_raw(self)
    }

    unsafe fn from_raw(ptr: *mut T) -> Self {
        Box::from_raw(ptr)
    }
}

impl<T: WakeRef + ?Sized> WakeRef for Box<T> {
    #[inline]
    fn wake_by_ref(&self) {
        T::wake_by_ref(self.as_ref())
    }
}

impl<T: Wake> Wake for Box<T> {
    #[inline]
    fn wake(self) {
        T::wake(*self)
    }
}

unsafe impl<T: ?Sized> ViaRawPointer for arc::Arc<T> {
    type Target = T;

    fn into_raw(self) -> *mut T {
        arc::Arc::into_raw(self) as *mut T
    }

    unsafe fn from_raw(ptr: *mut T) -> Self {
        arc::Arc::from_raw(ptr as *const T)
    }
}

impl<T: WakeRef + ?Sized> WakeRef for arc::Arc<T> {
    #[inline]
    fn wake_by_ref(&self) {
        T::wake_by_ref(self.as_ref())
    }
}

impl<T: WakeRef + ?Sized> Wake for arc::Arc<T> {}

unsafe impl<T> ViaRawPointer for arc::Weak<T> {
    type Target = T;

    fn into_raw(self) -> *mut T {
        arc::Weak::into_raw(self) as *mut T
    }

    unsafe fn from_raw(ptr: *mut T) -> Self {
        arc::Weak::from_raw(ptr as *const T)
    }
}

impl<T: WakeRef + ?Sized> WakeRef for arc::Weak<T> {
    #[inline]
    fn wake_by_ref(&self) {
        self.upgrade().wake()
    }
}

impl<T: WakeRef + ?Sized> Wake for arc::Weak<T> {}

impl<T: WakeRef + ?Sized> WakeRef for rc::Rc<T> {
    #[inline]
    fn wake_by_ref(&self) {
        T::wake_by_ref(self.as_ref())
    }
}

unsafe impl<T: ?Sized> ViaRawPointer for rc::Rc<T> {
    type Target = T;

    fn into_raw(self) -> *mut T {
        rc::Rc::into_raw(self) as *mut T
    }

    unsafe fn from_raw(ptr: *mut T) -> Self {
        rc::Rc::from_raw(ptr as *const T)
    }
}

impl<T: WakeRef + ?Sized> Wake for rc::Rc<T> {
    #[inline]
    fn wake(self) {
        T::wake_by_ref(self.as_ref())
    }
}

unsafe impl<T> ViaRawPointer for rc::Weak<T> {
    type Target = T;

    fn into_raw(self) -> *mut T {
        rc::Weak::into_raw(self) as *mut T
    }

    unsafe fn from_raw(ptr: *mut T) -> Self {
        rc::Weak::from_raw(ptr as *const T)
    }
}

impl<T: WakeRef + ?Sized> WakeRef for rc::Weak<T> {
    #[inline]
    fn wake_by_ref(&self) {
        self.upgrade().wake()
    }
}

impl<T: WakeRef + ?Sized> Wake for rc::Weak<T> {}

unsafe impl<T: ViaRawPointer> ViaRawPointer for Option<T>
where
    T::Target: Sized,
{
    type Target = T::Target;

    fn into_raw(self) -> *mut Self::Target {
        match self {
            Some(value) => match value.into_raw() {
                ptr if ptr.is_null() => {
                    let _ = unsafe { T::from_raw(ptr) };
                    ptr::null_mut()
                }
                ptr => ptr,
            },
            None => ptr::null_mut(),
        }
    }

    unsafe fn from_raw(ptr: *mut Self::Target) -> Self {
        match ptr.is_null() {
            false => Some(T::from_raw(ptr)),
            true => None,
        }
    }
}

impl<T: WakeRef> WakeRef for Option<T> {
    #[inline]
    fn wake_by_ref(&self) {
        if let Some(waker) = self {
            waker.wake_by_ref()
        }
    }
}

impl<T: Wake> Wake for Option<T> {
    #[inline]
    fn wake(self) {
        if let Some(waker) = self {
            waker.wake()
        }
    }
}

impl WakeRef for Waker {
    #[inline]
    fn wake_by_ref(&self) {
        Waker::wake_by_ref(self)
    }
}

impl Wake for Waker {
    #[inline]
    fn wake(self) {
        Waker::wake(self)
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use std::panic;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::Waker;

    static PANIC_WAKE_REF_COUNT: AtomicUsize = AtomicUsize::new(0);
    static PANIC_WAKE_VALUE_COUNT: AtomicUsize = AtomicUsize::new(0);
    static PANIC_DROP_COUNT: AtomicUsize = AtomicUsize::new(0);

    #[derive(Debug, Clone)]
    struct PanicWaker;

    impl WakeRef for PanicWaker {
        fn wake_by_ref(&self) {
            PANIC_WAKE_REF_COUNT.fetch_add(1, Ordering::SeqCst);
            panic!();
        }
    }

    impl Wake for PanicWaker {
        fn wake(self) {
            PANIC_WAKE_VALUE_COUNT.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl Drop for PanicWaker {
        fn drop(&mut self) {
            PANIC_DROP_COUNT.fetch_add(1, Ordering::SeqCst);
        }
    }

    unsafe impl ViaRawPointer for PanicWaker {
        type Target = ();

        fn into_raw(self) -> *mut () {
            std::mem::forget(self);
            std::ptr::null_mut()
        }

        unsafe fn from_raw(_ptr: *mut ()) -> Self {
            PanicWaker
        }
    }

    // Test that the wake_by_ref() behaves correctly even if it panics.
    #[test]
    fn panic_wake() {
        assert_eq!(PANIC_DROP_COUNT.load(Ordering::SeqCst), 0);

        let waker = PanicWaker;
        {
            let waker1: Waker = waker.into_waker();

            let waker2: Waker = waker1.clone();

            let result = panic::catch_unwind(|| {
                waker2.wake_by_ref();
            });
            assert!(result.is_err());
            assert_eq!(PANIC_WAKE_REF_COUNT.load(Ordering::SeqCst), 1);
            assert_eq!(PANIC_DROP_COUNT.load(Ordering::SeqCst), 0);

            let result = panic::catch_unwind(|| {
                waker1.wake_by_ref();
            });
            assert!(result.is_err());
            assert_eq!(PANIC_WAKE_REF_COUNT.load(Ordering::SeqCst), 2);
            assert_eq!(PANIC_DROP_COUNT.load(Ordering::SeqCst), 0);

            let result = panic::catch_unwind(|| {
                waker1.wake();
            });
            assert!(result.is_ok());
            assert_eq!(PANIC_WAKE_VALUE_COUNT.load(Ordering::SeqCst), 1);
            assert_eq!(PANIC_DROP_COUNT.load(Ordering::SeqCst), 1);
        }
        assert_eq!(PANIC_DROP_COUNT.load(Ordering::SeqCst), 2);
    }
}
