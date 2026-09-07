//! A library to quickly get the live/total/max counts of allocated instances.
//!
//! # Example
//!
//! ```
//! # if cfg!(not(feature = "enable")) { return; }
//!
//! #[derive(Default)]
//! struct Widget {
//!   _c: countme::Count<Self>,
//! }
//!
//! countme::enable(true);
//!
//! let w1 = Widget::default();
//! let w2 = Widget::default();
//! let w3 = Widget::default();
//! drop(w1);
//!
//! let counts = countme::get::<Widget>();
//! assert_eq!(counts.live, 2);
//! assert_eq!(counts.max_live, 3);
//! assert_eq!(counts.total, 3);
//!
//! eprintln!("{}", countme::get_all());
//! ```
//!
//! # Configuration
//!
//! By default, the implementation compiles to no-ops. Therefore it is possible
//! to include `Count` fields into library types.
//!
//! The `enable` cargo feature ungates the counting code. The feature can be
//! enabled anywhere in the crate graph.
//!
//! At run-time, the counters are controlled with [`enable`] function. Counting
//! is enabled by default if `print_at_exit` feature is enabled. Otherwise
//! counting is disabled by default. Call `enable(true)` early in `main` to enable:
//!
//! ```rust
//! fn main() {
//!     countme::enable(std::env::var("COUNTME").is_ok());
//! }
//! ```
//!
//! The code is optimized for the case where counting is not enabled at runtime
//! (counting is a relaxed load and a branch to a function call).
//!
//! The `print_at_exit` Cargo feature uses `atexit` call to print final counts
//! before the program exits (it also enables counting at runtime). Use it only
//! when you can't modify the main to print counts -- `atexit` is not guaranteed
//! to work with rust's runtime.
#[cfg(feature = "enable")]
mod imp;

use std::{fmt, marker::PhantomData};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct Counts {
    /// The total number of tokens created.
    pub total: usize,
    /// The historical maximum of the `live` count.
    pub max_live: usize,
    /// The number of tokens which were created, but are not destroyed yet.
    pub live: usize,
}

/// Store this inside your struct as `_c: countme::Count<Self>`.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Count<T: 'static> {
    ghost: PhantomData<fn(T)>,
}

impl<T: 'static> Default for Count<T> {
    #[inline]
    fn default() -> Self {
        Self::new()
    }
}

impl<T: 'static> Clone for Count<T> {
    #[inline]
    fn clone(&self) -> Self {
        Self::new()
    }
}

impl<T: 'static> Count<T> {
    /// Create new `Count`, incrementing the corresponding count.
    #[inline]
    pub fn new() -> Count<T> {
        #[cfg(feature = "enable")]
        imp::inc::<T>();
        Count { ghost: PhantomData }
    }
}

impl<T: 'static> Drop for Count<T> {
    #[inline]
    fn drop(&mut self) {
        #[cfg(feature = "enable")]
        imp::dec::<T>();
    }
}

/// Enable or disable counting at runtime.
///
/// Counting is enabled by default if `print_at_exit` feature is enabled.
/// Otherwise counting is disabled by default.
///
/// If neither `enable` nor `print_at_exit` features are enabled, then this function is noop.
pub fn enable(_yes: bool) {
    #[cfg(feature = "enable")]
    imp::enable(_yes);
}

/// Returns the counts for the `T` type.
#[inline]
pub fn get<T: 'static>() -> Counts {
    #[cfg(feature = "enable")]
    {
        return imp::get::<T>();
    }
    #[cfg(not(feature = "enable"))]
    {
        return Counts::default();
    }
}

/// Returns a collection of counts for all types.
pub fn get_all() -> AllCounts {
    #[cfg(feature = "enable")]
    {
        return imp::get_all();
    }
    #[cfg(not(feature = "enable"))]
    {
        return AllCounts::default();
    }
}

/// A collection of counts for all types.
#[derive(Default, Clone, Debug)]
pub struct AllCounts {
    entries: Vec<(&'static str, Counts)>,
}

impl fmt::Display for AllCounts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn sep(mut n: usize) -> String {
            let mut groups = Vec::new();
            while n >= 1000 {
                groups.push(format!("{:03}", n % 1000));
                n /= 1000;
            }
            groups.push(n.to_string());
            groups.reverse();
            groups.join("_")
        }

        if self.entries.is_empty() {
            return if cfg!(feature = "enable") {
                writeln!(f, "all counts are zero")
            } else {
                writeln!(f, "counts are disabled")
            };
        }
        let max_width =
            self.entries.iter().map(|(name, _count)| name.chars().count()).max().unwrap_or(0);
        for (name, counts) in &self.entries {
            writeln!(
                f,
                "{:<max_width$}  {:>12} {:>12} {:>12}",
                name,
                sep(counts.total),
                sep(counts.max_live),
                sep(counts.live),
                max_width = max_width
            )?;
        }
        writeln!(
            f,
            "{:<max_width$}  {:>12} {:>12} {:>12}",
            "",
            "total",
            "max_live",
            "live",
            max_width = max_width
        )?;
        Ok(())
    }
}
