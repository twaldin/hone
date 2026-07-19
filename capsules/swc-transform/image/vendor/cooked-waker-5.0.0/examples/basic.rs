use cooked_waker::{IntoWaker, ViaRawPointer, Wake, WakeRef};
use std::{sync::Arc, task::Waker};

#[derive(Debug, Clone)]
struct CustomWaker {
    id: i32,
}

impl WakeRef for CustomWaker {
    fn wake_by_ref(&self) {
        println!("wake by ref: {}", self.id);
    }
}

impl Wake for CustomWaker {
    fn wake(self) {
        println!("wake by value: {}", self.id);
    }
}

impl Drop for CustomWaker {
    fn drop(&mut self) {
        println!("dropping waker: {}", self.id);
    }
}

unsafe impl ViaRawPointer for CustomWaker {
    type Target = ();

    fn into_raw(self) -> *mut Self::Target {
        self.id as *mut ()
    }

    unsafe fn from_raw(ptr: *mut Self::Target) -> Self {
        Self { id: ptr as i32 }
    }
}

fn main() {
    println!("Hello, world!");
    let waker = CustomWaker { id: 11 };
    let waker: Waker = waker.into_waker();

    println!("Waker: {:?}", waker);
    waker.wake_by_ref();
    waker.wake();

    let waker = CustomWaker { id: 12 };
    let handle1 = Arc::new(waker);

    let handle1: Waker = handle1.into_waker();
    let handle2: Waker = handle1.clone();
    let handle3: Waker = handle2.clone();

    println!("Handles:\n{:?}\n{:?}\n{:?}", handle1, handle2, handle3);
    handle1.wake_by_ref();
    handle1.wake();

    handle2.wake_by_ref();
    handle2.wake();
}
