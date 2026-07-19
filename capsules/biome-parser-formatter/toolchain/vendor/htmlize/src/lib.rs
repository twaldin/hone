//! # Which `escape` function to use
//!
//! Generally, if the text goes in an attribute, use [`escape_attribute()`],
//! otherwise, use [`escape_text()`]. If you need bytes (`[u8]`) instead of a
//! `String`, use the `_bytes` version of the functions:
//! [`escape_attribute_bytes()`] and [`escape_text_bytes()`].
//!
//! |                         | `&` | `<` | `>` | `"` | `'` |
//! |-------------------------|:---:|:---:|:---:|:---:|:---:|
//! | [`escape_text()`]       |  ✓  |  ✓  |  ✓  |     |     |
//! | [`escape_attribute()`]  |  ✓  |  ✓  |  ✓  |  ✓  |     |
//! | [`escape_all_quotes()`] |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |
//!
//! You should almost never need [`escape_all_quotes()`], but it’s included
//! because sometimes it’s convenient to wrap attribute values in single quotes.
//!
//! # Which `unescape` function to use
//!
//! [`unescape()`] is probably fine for most uses. To be strictly correct, you
//! should use [`unescape_attribute()`] for attribute values.
//!
//! [`unescape_in()`] handles either depending on the value of the `context`
//! parameter. See its documentation for a discussion of the differences between
//! expanding attribute values and general text.
//!
//! [`unescape_bytes_in()`] is just like [`unescape_in()`] except that it works
//! on `[u8]` rather than strings.
//!
//! # Features
//!
//! The `escape` functions are all available with no features enabled.
//!
//!   * `unescape_fast`: provide fast version of [`unescape()`]. This does _not_
//!     enable the `entities` feature automatically.
//!
//!     This takes perhaps 30 seconds longer to build than `unescape`, but the
//!     performance is significantly better in the worst cases. That said, the
//!     performance of of the `unescape` version is already pretty good, so I
//!     don’t recommend enabling this unless you really need it.
//!
//!   * `unescape`: provide normal version of [`unescape()`]. This will
//!     automatically enable the `entities` feature.
//!
//!   * `entities`: build [`ENTITIES`] map. Enabling this will add a dependency
//!     on [phf] and may slow builds by a few seconds.
//!
//! ### Internal features
//!
//!   * `iai`: enable [iai] benchmarks. This should only be used when running
//!     benchmarks. See the [Benchmarks section in the README][benchmarks].
//!
//!   * `bench`: enable unescape benchmarks by making internal functions like
//!     `unescape_fast()` public. This must only be used when running
//!     benchmarks. It is required to run unescape benchmarks. See the
//!     [Benchmarks section in the README][benchmarks].
//!
//!   * `_unescape_either`: used internally to configure benchmarks. You should
//!     not specify this directly. It is automatically enabled when
//!     `unescape_fast` or `unescape` are enabled.
//!
//! # Minimum supported Rust version
//!
//! Currently the minimum supported Rust version (MSRV) is **1.60**. Future
//! increases in the MSRV will require a major version bump.
//!
//! [phf]: https://crates.io/crates/phf
//! [iai]: https://crates.io/crates/iai
//! [benchmarks]: https://github.com/danielparks/htmlize#benchmarks

// Lint configuration in Cargo.toml isn’t supported by cargo-geiger.
#![forbid(unsafe_code)]
// Enable doc_cfg on docsrs so that we get feature markers.
#![cfg_attr(docsrs, feature(doc_cfg))]

/// Mark items as requiring a feature on docs.rs.
///
/// Thanks to Tokio for this macro (via nix).
macro_rules! feature {
    (
        #![$meta:meta]
        $($item:item)*
    ) => {
        $(
            #[cfg($meta)]
            #[cfg_attr(docsrs, doc(cfg($meta)))]
            $item
        )*
    }
}

mod escape;
pub use escape::*;

feature! {
    #![any(feature = "unescape", feature = "unescape_fast")]

    mod unescape;
    pub use unescape::*;
}

feature! {
    #![feature = "entities"]

    mod entities;
    pub use entities::*;
}
