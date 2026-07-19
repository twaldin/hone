//! Read files in the WEBC format.
//!
//! There are several readers to choose from, depending on the use case.
//!
//! An [`OwnedReader`] is the most convenient to work with because it owns the
//! buffer containing the `*.webc` file, so it is able to retrieve or parse
//! arbitrary parts of the file as necessary. Due to the use of
//! [`shared_buffer::OwnedBuffer`], it is possible to use mmap to avoid keeping
//! the entire file in memory.
//!
//! A [`StreamingReader`] will read data from some [`std::io::Read`] object and
//! parse it on-demand. This isn't as flexible as [`OwnedReader`], but can be
//! less memory-intensive for use cases where random access isn't required.

#![cfg_attr(
    not(test),
    deny(
        clippy::indexing_slicing,
        clippy::panic,
        clippy::todo,
        clippy::unwrap_used
    )
)]

mod decoder;
mod dir_entry;
mod owned;
mod scanner;
mod sections;
mod streaming;
pub(crate) mod volume_header;

pub use self::{
    dir_entry::{DirEntry, DirEntryError, Directory, FileEntry},
    owned::{OwnedReader, OwnedReaderError},
    sections::{
        AtomsSection, IndexSection, LookupError, ManifestSection, Section, SectionError,
        VolumeSection,
    },
    streaming::{StreamingReader, StreamingReaderError},
    volume_header::VolumeHeaderError,
};
