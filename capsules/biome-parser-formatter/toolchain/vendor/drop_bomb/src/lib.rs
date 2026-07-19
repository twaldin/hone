//! # drop_bomb
//!
//! `drop_bomb` provides two types, `DropBomb` and `DebugDropBomb`,
//! which panic in `drop` with a specified message unless
//! defused. This is useful as a building-block for runtime-checked
//! linear types.
//!
//! For example, one can build a variant of `BufWriter` which enforces
//! handling of errors during flush.
//!
//! ```rust
//! extern crate drop_bomb;
//!
//! use std::io::{Write, BufWriter, Result};
//! use drop_bomb::DropBomb;
//!
//! struct CheckedBufWriter<W: Write> {
//!     inner: BufWriter<W>,
//!     bomb: DropBomb,
//! }
//!
//! impl<W: Write> CheckedBufWriter<W> {
//!     fn new(inner: BufWriter<W>) -> CheckedBufWriter<W> {
//!         let bomb = DropBomb::new(
//!             "CheckedBufWriter must be explicitly closed \
//!              to handle potential errors on flush"
//!         );
//!         CheckedBufWriter { inner, bomb }
//!     }
//!
//!     fn close(mut self) -> Result<()> {
//!         self.bomb.defuse();
//!         self.inner.flush()?;
//!         Ok(())
//!     }
//! }
//! ```
//!
//! ## Notes:
//!
//! * Bombs do nothing if a thread is already panicking.
//! * When `#[cfg(debug_assertions)]` is disabled, `DebugDropBomb` is
//!   always defused and has a zero size.
use std::borrow::Cow;

#[derive(Debug)]
#[must_use]
pub struct DropBomb(RealBomb);

impl DropBomb {
    pub fn new(msg: impl Into<Cow<'static, str>>) -> DropBomb {
        DropBomb(RealBomb::new(msg.into()))
    }
    pub fn defuse(&mut self) {
        self.set_defused(true)
    }
    pub fn set_defused(&mut self, defused: bool) {
        self.0.set_defused(defused)
    }
    pub fn is_defused(&self) -> bool {
        self.0.is_defused()
    }
}

#[derive(Debug)]
#[must_use]
pub struct DebugDropBomb(DebugBomb);

impl DebugDropBomb {
    pub fn new(msg: impl Into<Cow<'static, str>>) -> DebugDropBomb {
        DebugDropBomb(DebugBomb::new(msg.into()))
    }
    pub fn defuse(&mut self) {
        self.set_defused(true)
    }
    pub fn set_defused(&mut self, defused: bool) {
        self.0.set_defused(defused)
    }
    pub fn is_defused(&self) -> bool {
        self.0.is_defused()
    }
}

#[cfg(debug_assertions)]
type DebugBomb = RealBomb;
#[cfg(not(debug_assertions))]
type DebugBomb = FakeBomb;

#[derive(Debug)]
struct RealBomb {
    msg: Cow<'static, str>,
    defused: bool,
}

impl RealBomb {
    fn new(msg: Cow<'static, str>) -> RealBomb {
        RealBomb {
            msg: msg.into(),
            defused: false,
        }
    }
    fn set_defused(&mut self, defused: bool) {
        self.defused = defused
    }
    fn is_defused(&self) -> bool {
        self.defused
    }
}

impl Drop for RealBomb {
    fn drop(&mut self) {
        if !self.defused && !::std::thread::panicking() {
            panic!("{}", self.msg)
        }
    }
}

#[derive(Debug)]
#[cfg(not(debug_assertions))]
struct FakeBomb {}

#[cfg(not(debug_assertions))]
impl FakeBomb {
    fn new(_msg: Cow<'static, str>) -> FakeBomb {
        FakeBomb {}
    }
    fn set_defused(&mut self, _defused: bool) {}
    fn is_defused(&self) -> bool {
        true
    }
}

#[cfg(not(debug_assertions))]
impl Drop for FakeBomb {
    fn drop(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[should_panic(expected = "Kaboom")]
    fn armed_bomb_bombs() {
        let _b = DropBomb::new("Kaboom");
    }

    #[test]
    fn defused_bomb_is_safe() {
        let mut b = DropBomb::new("Kaboom");
        assert!(!b.is_defused());
        b.defuse();
        assert!(b.is_defused());
    }

    #[test]
    #[should_panic(expected = r#"printf("sucks to be you"); exit(666);"#)]
    fn no_double_panics() {
        let _b = DropBomb::new("Kaboom");
        panic!(r#"printf("sucks to be you"); exit(666);"#)
    }

    #[test]
    #[should_panic(expected = "Kaboom")]
    #[cfg(debug_assertions)]
    fn debug_bomb_bombs_if_debug() {
        let _b = DebugDropBomb::new("Kaboom");
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn debug_bomb_bombs_if_debug() {
        let _b = DebugDropBomb::new("Kaboom");
    }

    #[test]
    fn defused_bomb_is_safe_if_debug() {
        let mut b = DebugDropBomb::new("Kaboom");
        #[cfg(debug_assertions)]
        assert!(!b.is_defused());
        #[cfg(not(debug_assertions))]
        assert!(b.is_defused());
        b.defuse();
        assert!(b.is_defused());
    }

    #[test]
    #[should_panic(expected = r#"printf("sucks to be you"); exit(666);"#)]
    fn no_double_panics_if_debug() {
        let _b = DebugDropBomb::new("Kaboom");
        panic!(r#"printf("sucks to be you"); exit(666);"#)
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn debug_bomb_is_zst() {
        assert_eq!(::std::mem::size_of::<DebugDropBomb>(), 0);
    }

    #[test]
    fn check_traits() {
        fn assert_traits<T: ::std::fmt::Debug + Send + Sync>() {}
        assert_traits::<DropBomb>();
        assert_traits::<DebugDropBomb>();
    }
}
