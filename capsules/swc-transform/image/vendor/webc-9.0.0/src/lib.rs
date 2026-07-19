//! A library for reading and writing WEBC files.
//!
//! The [`Container`] provides an abstraction over the various WEBC versions
//! this crate can handle. As such, it tries to cater to the lowest common
//! denominator and favors portability over performance or power.
//!
//! ```rust,no_run
//! use webc::{Container, Version};
//! let bytes: &[u8] = b"\0webc...";
//!
//! let container = Container::from_bytes_and_version(bytes.into(), Version::V3)?;
//!
//! println!("{:?}", container.manifest());
//!
//! println!("Atoms:");
//! for (name, atom) in container.atoms() {
//!     let length = atom.len();
//!     println!("{name}: {length} bytes");
//! }
//!
//! for (name, volume) in container.volumes() {
//!     let root_items = volume.read_dir("/").expect("The root directory always exists");
//!     println!("{name}: {} items", root_items.len());
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! In general, errors that occur during lazy operations won't be accessible to
//! the user.
//!
//! # Version-Specific Fallbacks
//!
//! If more flexibility is required, consider using [`crate::detect()`] and
//! instantiating a compatible parser directly.
//!
//! ```rust,no_run
//! use webc::{
//!     Container,
//!     Version,
//! };
//! # #[cfg(feature = "v1")]
//! use webc::v1::{ParseOptions, WebC};
//! # #[cfg(feature = "v3")]
//! use webc::v3::read::OwnedReader;
//! let bytes: &[u8] = b"...";
//!
//! match webc::detect(bytes) {
//! #   #[cfg(feature = "v1")]
//!     Ok(Version::V1) => {
//!         let options = ParseOptions::default();
//!         let webc = WebC::parse(bytes, &options).unwrap();
//!         if let Some(signature) = webc.signature {
//!             println!("Package signature: {:?}", signature);
//!         }
//!     }
//! #   #[cfg(feature = "v3")]
//!     Ok(Version::V3) => {
//!         let webc = OwnedReader::parse(bytes).unwrap();
//!         let index = webc.index();
//!         let signature = &index.signature;
//!         if !signature.is_none() {
//!             println!("Package signature: {signature:?}");
//!         }
//!     }
//!     Ok(other) => todo!("Unsupported version, {other}"),
//!     Err(e) => todo!("An error occurred: {e}"),
//! }
//! ```
//!
//! # Feature Flags
//!
#![doc = document_features::document_features!()]
#![warn(unreachable_pub, elided_lifetimes_in_paths)]
#![deny(missing_docs, missing_debug_implementations)]
#![cfg_attr(docsrs, feature(doc_cfg, doc_auto_cfg))]

pub extern crate bytes;
pub extern crate indexmap;

#[cfg(test)]
#[macro_use]
extern crate pretty_assertions;

#[cfg(test)]
#[macro_use]
#[allow(dead_code, unused_macros)]
mod macros;

mod container;
mod detect;
mod from_path_with_ignore;
pub mod metadata;
mod path_segments;
mod readable_bytes;
mod timestamps;
mod utils;
#[allow(missing_docs)]
#[cfg(feature = "v1")]
pub mod v1;
#[cfg(feature = "v2")]
pub mod v2;
#[cfg(feature = "v3")]
pub mod v3;

#[cfg(all(feature = "v2", feature = "v3"))]
pub mod migration;

mod version;
mod volume;

/// The type for [`MAGIC`].
pub type Magic = [u8; 5];

/// File identification bytes stored at the beginning of the file.
pub const MAGIC: Magic = *b"\0webc";

pub use crate::{
    container::{Container, ContainerError},
    detect::{detect, is_webc, DetectError},
    from_path_with_ignore::DirectoryFromPathError,
    path_segments::{PathSegment, PathSegmentError, PathSegments, ToPathSegments},
    timestamps::Timestamps,
    utils::sanitize_path,
    version::Version,
    volume::{AbstractVolume, Metadata, Volume, VolumeError},
};

pub(crate) use timestamps::since_epoch;

#[doc(hidden)] // HACK: Made accessible for wasmer-cli. Not for public use.
pub use crate::container::{AbstractWebc, AsAny};

/// A compatibility layer for dealing with different versions of the WEBC binary
/// format.
#[deprecated(since = "5.1.0", note = "Import types directly from the crate")]
pub mod compat {
    pub use crate::{
        container::{Container, ContainerError},
        volume::{Metadata, Volume, VolumeError},
    };

    #[deprecated = "Use shared_buffer::OwnedBuffer directly"]
    pub use shared_buffer::OwnedBuffer as SharedBytes;
}
