//! [![Latest Version](https://img.shields.io/crates/v/radix_fmt.svg)](https://crates.io/crates/radix_fmt)
//! [![Documentation](https://img.shields.io/badge/api-rustdoc-purple.svg)](https://docs.rs/radix_fmt)
//!
//! This crate adds a tool to format a number in an arbitrary base from 2 to 36.
//!
//! This is a light crate, without any dependency.
//!
//! For primitive signed integers (`i8` to `i128`, and `isize`), negative values are
//! formatted as the two’s complement representation.
//!
//! There is also one specific function for each radix that does not
//! already exists in the standard library, *e.g.* [`radix_3`](fn.radix_3.html)
//! to format a number in base 3.
//!
//! Get started
//! -----------
//!
//! Add the crate to the cargo manifest:
//!
//! ```toml
//! radix_fmt = "1"
//! ```
//!
//! Import [`radix`](fn.radix.html) in scope,
//! and you are ready to go:
//!
//! ```rust
//! use radix_fmt::radix;
//! ```
//!
//! Examples
//! --------
//!
//! ```rust
//! use radix_fmt::*;
//!
//! let n = 35;
//!
//! // Ouput: "z"
//! println!("{}", radix(n, 36));
//! // Same ouput: "z"
//! println!("{}", radix_36(n));
//! ```
//!
//! You can use the *alternate* modifier to capitalize the letter-digits:
//!
//! ```rust
//! use radix_fmt::radix;
//!
//! let n = 35;
//!
//! // Ouput: "Z"
//! println!("{:#}", radix(n, 36));
//! ```

#[cfg(test)]
mod tests;

use core::num::{NonZeroI128, NonZeroU128};
use core::num::{NonZeroI16, NonZeroU16};
use core::num::{NonZeroI32, NonZeroU32};
use core::num::{NonZeroI64, NonZeroU64};
use core::num::{NonZeroI8, NonZeroU8};
use core::num::{NonZeroIsize, NonZeroUsize};
use std::fmt::{Display, Formatter, Result};
use std::iter::successors;

/// A struct to format a number in an arbitrary radix.
///
/// # Example:
///
/// ```rust
/// use radix_fmt::Radix;
/// use std::fmt::Write;
///
/// let n = 15;
/// let mut s = String::new();
///
/// write!(&mut s, "{}", Radix::new(n, 3));
/// assert_eq!(s, "120"); // 15 is "120" in base 3
/// ```
#[derive(Debug, Clone, Copy)]
pub struct Radix<T> {
    n: T,
    base: u8,
}

impl<T> Radix<T>
where
    Radix<T>: Display,
{
    /// Create a new displayable number from number and base.
    /// The base must be in the range [2, 36].
    pub fn new(n: T, base: u8) -> Self {
        assert!(base >= 2 && base <= 36);

        Radix { n, base }
    }
}

#[inline(always)]
fn digit(u: u8, alternate: bool) -> u8 {
    let a = if alternate { b'A' } else { b'a' };

    match u {
        0...9 => u + b'0',
        10...35 => u - 10 + a,
        _ => unreachable!("Digit is not in range [0..36]"),
    }
}

const BUF_SIZE: usize = 81; // u128::max_value() in base 3 takes 81 digits to write.

macro_rules! impl_display_for {
    ($i: ty => $via: ty as $u: ty) => {
        impl Display for Radix<$i> {
            fn fmt(&self, f: &mut Formatter) -> Result {
                fn do_format(n: $u, base: $u, f: &mut Formatter) -> Result {
                    let mut buffer = [0_u8; BUF_SIZE];
                    let divided = successors(Some(n), |n| match n / base {
                        0 => None,
                        n => Some(n),
                    });
                    let written = buffer
                        .iter_mut()
                        .rev()
                        .zip(divided)
                        .map(|(c, n)| *c = digit((n % base) as u8, f.alternate()))
                        .count();
                    let index = BUF_SIZE - written;

                    // There are only ASCII chars inside the buffer, so the string
                    // is guaranteed to be a valid UTF-8 string.
                    let s = unsafe { std::str::from_utf8_unchecked(&buffer[index..]) };

                    f.write_str(s)
                }

                match (self.base, f.alternate()) {
                    (2, _) => write!(f, "{:b}", self.n),
                    (8, _) => write!(f, "{:o}", self.n),
                    (10, _) => write!(f, "{}", self.n),
                    (16, false) => write!(f, "{:x}", self.n),
                    (16, true) => write!(f, "{:X}", self.n),
                    (base, _) => do_format(<$via>::from(self.n) as $u, base.into(), f),
                }
            }
        }
    };
}

impl_display_for!(i8 => i8 as u8);
impl_display_for!(u8 => u8 as u8);

impl_display_for!(i16 => i16 as u16);
impl_display_for!(u16 => u16 as u16);

impl_display_for!(i32 => i32 as u32);
impl_display_for!(u32 => u32 as u32);

impl_display_for!(i64 => i64 as u64);
impl_display_for!(u64 => u64 as u64);

impl_display_for!(i128 => i128 as u128);
impl_display_for!(u128 => u128 as u128);

impl_display_for!(isize => isize as usize);
impl_display_for!(usize => usize as usize);

impl_display_for!(NonZeroI8 => i8 as u8);
impl_display_for!(NonZeroU8 => u8 as u8);

impl_display_for!(NonZeroI16 => i16 as u16);
impl_display_for!(NonZeroU16 => u16 as u16);

impl_display_for!(NonZeroI32 => i32 as u32);
impl_display_for!(NonZeroU32 => u32 as u32);

impl_display_for!(NonZeroI64 => i64 as u64);
impl_display_for!(NonZeroU64 => u64 as u64);

impl_display_for!(NonZeroI128 => i128 as u128);
impl_display_for!(NonZeroU128 => u128 as u128);

impl_display_for!(NonZeroIsize => isize as usize);
impl_display_for!(NonZeroUsize => usize as usize);

/// A helper for creating a new formatter from
/// [`Radix::new`](struct.Radix.html#method.new).
///
/// # Example:
///
/// ```rust
/// use radix_fmt::radix;
///
/// // Similar to println!("{}", Radix::new(123, 10));
/// // Prints: "123"
/// println!("{}", radix(123, 10));
/// ```
pub fn radix<T>(n: T, base: u8) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, base)
}
/// Formats a number in base 3.
pub fn radix_3<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 3)
}
/// Formats a number in base 4.
pub fn radix_4<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 4)
}
/// Formats a number in base 5.
pub fn radix_5<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 5)
}
/// Formats a number in base 6.
pub fn radix_6<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 6)
}
/// Formats a number in base 7.
pub fn radix_7<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 7)
}
/// Formats a number in base 9.
pub fn radix_9<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 9)
}
/// Formats a number in base 11.
pub fn radix_11<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 11)
}
/// Formats a number in base 12.
pub fn radix_12<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 12)
}
/// Formats a number in base 13.
pub fn radix_13<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 13)
}
/// Formats a number in base 14.
pub fn radix_14<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 14)
}
/// Formats a number in base 15.
pub fn radix_15<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 15)
}
/// Formats a number in base 17.
pub fn radix_17<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 17)
}
/// Formats a number in base 18.
pub fn radix_18<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 18)
}
/// Formats a number in base 19.
pub fn radix_19<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 19)
}
/// Formats a number in base 20.
pub fn radix_20<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 20)
}
/// Formats a number in base 21.
pub fn radix_21<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 21)
}
/// Formats a number in base 22.
pub fn radix_22<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 22)
}
/// Formats a number in base 23.
pub fn radix_23<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 23)
}
/// Formats a number in base 24.
pub fn radix_24<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 24)
}
/// Formats a number in base 25.
pub fn radix_25<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 25)
}
/// Formats a number in base 26.
pub fn radix_26<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 26)
}
/// Formats a number in base 27.
pub fn radix_27<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 27)
}
/// Formats a number in base 28.
pub fn radix_28<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 28)
}
/// Formats a number in base 29.
pub fn radix_29<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 29)
}
/// Formats a number in base 30.
pub fn radix_30<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 30)
}
/// Formats a number in base 31.
pub fn radix_31<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 31)
}
/// Formats a number in base 32.
pub fn radix_32<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 32)
}
/// Formats a number in base 33.
pub fn radix_33<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 33)
}
/// Formats a number in base 34.
pub fn radix_34<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 34)
}
/// Formats a number in base 35.
pub fn radix_35<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 35)
}
/// Formats a number in base 36.
pub fn radix_36<T>(n: T) -> Radix<T>
where
    Radix<T>: Display,
{
    Radix::new(n, 36)
}
