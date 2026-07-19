#![cfg(test)]

use crate::Error;
use crate::Value;
use core::mem::size_of;

// Ensure the value works well with derive macros.
#[cfg(feature = "derive")]
#[derive(serde::Serialize, serde::Deserialize)]
struct Bar(Value<'static>);

// Ensure the value works well with derive macros.
#[cfg(feature = "derive")]
#[derive(serde::Serialize, serde::Deserialize)]
struct Foo(Bar);

#[test]
fn value_size() {
    assert!(size_of::<Value>() <= 32);
}

#[test]
fn error_size() {
    assert!(size_of::<Error>() <= 8);
}
