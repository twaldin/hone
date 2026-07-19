//! Create files in the WEBC format.
//!
//! If you have landed on this page, you are probably looking for the [`Writer`]
//! type.
//!
//! The [`Writer`] uses [*The Typestate Pattern*][tsp] to ensure that each
//! section of the WEBC file is written in the correct order.
//!
//! # Examples
//!
//! ```rust,no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! use webc::{
//!     metadata::Manifest,
//!     v3::{
//!         write::{Writer, Directory, FileEntry},
//!         ChecksumAlgorithm, SignatureAlgorithm,
//!         Timestamps
//!     },
//! };
//! use std::collections::BTreeMap;
//! use bytes::Bytes;
//!
//! let manifest = Manifest::default();
//!
//! let mut atoms = BTreeMap::new();
//! atoms.insert("python".parse()?, FileEntry::borrowed(b"...", Timestamps::default()));
//!
//! let mut writer = Writer::new(ChecksumAlgorithm::Sha256)
//!     .write_manifest(&manifest)?
//!     .write_atoms(atoms)?;
//!
//! let volume_1 = Directory::from_path("./volume_1")?;
//! writer.write_volume("volume_1", volume_1)?;
//!
//! let buffer: Bytes = writer.finish(SignatureAlgorithm::None)?;
//! # Ok(()) }
//! ```
//!
//! [tsp]: http://cliffle.com/blog/rust-typestate/

pub(crate) mod volumes;
mod writer;

pub use self::{
    volumes::{DirEntry, Directory, FileEntry},
    writer::{Writer, WritingAtoms, WritingManifest, WritingVolumes},
};

pub(crate) use self::writer::Section;
