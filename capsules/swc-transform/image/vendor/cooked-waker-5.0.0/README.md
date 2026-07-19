[![Travis (.com)](https://img.shields.io/travis/com/Lucretiel/cooked-waker.svg?logo=travis)](https://travis-ci.com/Lucretiel/cooked-waker/) [![GitHub stars](https://img.shields.io/github/stars/Lucretiel/cooked-waker.svg?label=stars&logo=github&logoColor=white)](https://github.com/Lucretiel/cooked-waker) [![Crates.io](https://img.shields.io/crates/d/cooked-waker.svg?logo=rust&logoColor=white&label=crates.io)](https://crates.io/crates/cooked-waker) [![docs.rs](https://docs.rs/cooked-waker/badge.svg)](https://docs.rs/cooked-waker) [![license](https://img.shields.io/github/license/Lucretiel/cooked-waker.svg)](https://crates.io/crates/cooked-waker/)

# cooked-waker

cooked_waker provides safe traits for working with [`std::task::Waker`][waker] and creating those wakers out of regular, safe Rust structs. It cooks `RawWaker` and `RawWakerVTable`, making them safe for consumption.

It provides the `Wake` and `WakeRef` traits, which correspond to the `wake` and `wake_by_ref` methods on `std::task::Waker`, and it provides implenetations of these types for the common reference & pointer types (`Arc`, `Rc`, `&'static`, etc).

Additionally, it provides `IntoWaker`, which allows converting any `Wake + Clone` type into a `Waker`. This trait is automatically derived for any `Wake + Clone + Send + Sync + 'static` type.

# Basic example

```rust
use cooked_waker::{Wake, WakeRef, IntoWaker};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::Waker;

static wake_ref_count: AtomicUsize = AtomicUsize::new(0);
static wake_value_count: AtomicUsize = AtomicUsize::new(0);
static drop_count: AtomicUsize = AtomicUsize::new(0);

// A simple Waker struct that atomically increments the relevant static
// counters.
#[derive(Debug, Clone)]
struct StaticWaker;

impl WakeRef for StaticWaker {
    fn wake_by_ref(&self) {
        wake_ref_count.fetch_add(1, Ordering::SeqCst);
    }
}

impl Wake for StaticWaker {
    fn wake(self) {
        wake_value_count.fetch_add(1, Ordering::SeqCst);
    }
}

impl Drop for StaticWaker {
    fn drop(&mut self) {
        drop_count.fetch_add(1, Ordering::SeqCst);
    }
}

assert_eq!(drop_count.load(Ordering::SeqCst), 0);

let waker = StaticWaker;
{
    let waker1: Waker = waker.into_waker();

    waker1.wake_by_ref();
    assert_eq!(wake_ref_count.load(Ordering::SeqCst), 1);

    let waker2: Waker = waker1.clone();
    waker2.wake_by_ref();
    assert_eq!(wake_ref_count.load(Ordering::SeqCst), 2);

    waker1.wake();
    assert_eq!(wake_value_count.load(Ordering::SeqCst), 1);
    assert_eq!(drop_count.load(Ordering::SeqCst), 1);
}
assert_eq!(drop_count.load(Ordering::SeqCst), 2);
```

# Arc example

```rust
use cooked_waker::{Wake, WakeRef, IntoWaker};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::Waker;

// A simple struct that counts the number of times it is awoken. Can't
// be awoken by value (because that would discard the counter), so we
// must instead wrap it in an Arc.
#[derive(Debug, Default)]
struct Counter {
    // We use atomic usize because we need Send + Sync and also interior
    // mutability
    count: AtomicUsize,
}

impl Counter {
    fn get(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}

impl WakeRef for Counter {
    fn wake_by_ref(&self) {
        let _prev = self.count.fetch_add(1, Ordering::SeqCst);
    }
}

let counter_handle = Arc::new(Counter::default());

// Create an std::task::Waker
let waker: Waker = counter_handle.clone().into_waker();

waker.wake_by_ref();
waker.wake_by_ref();

let waker2 = waker.clone();
waker2.wake_by_ref();

// Because IntoWaker wrap the pointer directly, without additional
// boxing, we can use will_wake
assert!(waker.will_wake(&waker2));

// This calls Counter::wake_by_ref because the Arc doesn't have exclusive
// ownership of the underlying Counter
waker2.wake();

assert_eq!(counter_handle.get(), 4);
```
