#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(clippy::pedantic)]
#![deny(clippy::cargo)]
#![deny(warnings)]
// Don't panic!
#![cfg_attr(
    not(test),
    deny(
        clippy::panic,
        clippy::exit,
        clippy::unimplemented,
        clippy::todo,
        clippy::expect_used,
        clippy::unwrap_used,
        clippy::indexing_slicing,
        clippy::missing_panics_doc
    )
)]

pub use change::{Change, LoadingError, ParsingError, UniqueId};
pub use changeset::{ChangeSet, PackageChange, Release};
pub use versioning::{BuildVersioningError, ChangeType, PackageName, Versioning};

mod change;
mod changeset;
mod versioning;
