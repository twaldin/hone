// Copyright (c) 2023 Harry [Majored] [hello@majored.pw]
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

//! A ZIP reader which acts over a non-seekable source.
//!
//! # API Design
//! As opposed to other readers provided by this crate, it's important that the data of an entry is fully read before
//! the proceeding entry is read. This is as a result of not being able to seek forwards or backwards, so we must end
//! up at the start of the next entry.
//!
//! **We encode this invariant within Rust's type system so that it can be enforced at compile time.**
//!
//! This requires that any transition methods between these encoded types consume the reader and provide a new owned
//! reader back. This is certainly something to keep in mind when working with this reader, but idiomatic code can
//! still be produced nevertheless.
//!
//! # Considerations
//! As the central directory of a ZIP archive is stored at the end of it, a non-seekable reader doesn't have access
//! to it. We have to rely on information provided within the local file header which may not be accurate or complete.
//! This results in:
//! - The inability to read ZIP entries using the combination of a data descriptor and the Stored compression method.
//! - No file comment being available (defaults to an empty string).
//! - No internal or external file attributes being available (defaults to 0).
//! - The extra field data potentially being inconsistent with what's stored in the central directory.
//! - None of the following being available when the entry was written with a data descriptor (defaults to 0):
//!     - CRC
//!     - compressed size
//!     - uncompressed size
//!
//! # Example
//! ```no_run
//! # use futures_lite::io::Cursor;
//! # use async_zip::error::Result;
//! # use async_zip::base::read::stream::ZipFileReader;
//! #
//! # async fn run() -> Result<()> {
//! let mut zip = ZipFileReader::new(Cursor::new([0; 0]));
//!     
//! // Print the name of every file in a ZIP archive.
//! while let Some(entry) = zip.next_with_entry().await? {
//!     println!("File: {}", entry.reader().entry().filename().as_str().unwrap());
//!     (.., zip) = entry.skip().await?;
//! }
//! #
//! #     Ok(())
//! # }
//! ```

use crate::base::read::counting::Counting;
use crate::base::read::io::entry::ZipEntryReader;
use crate::error::Result;
use crate::error::ZipError;
use crate::spec::data_descriptor::{CombinedDataDescriptor, DataDescriptor, Zip64DataDescriptor};
#[cfg(feature = "tokio")]
use crate::tokio::read::stream::Ready as TokioReady;

use futures_lite::io::AsyncBufRead;
use futures_lite::io::AsyncReadExt;

use super::io::entry::WithEntry;
use super::io::entry::WithoutEntry;
use crate::spec::header::HeaderId;
#[cfg(feature = "tokio")]
use tokio_util::compat::TokioAsyncReadCompatExt;

/// A type which encodes that [`ZipFileReader`] is ready to open a new entry.
pub struct Ready<R>(R);

/// A type which encodes that [`ZipFileReader`] is currently reading an entry.
pub struct Reading<'a, R, E>(ZipEntryReader<'a, R, E>, Option<Suffix>);

#[derive(Copy, Clone, Debug)]
enum Suffix {
    /// The entry is followed by a data descriptor.
    DataDescriptor,
    /// The entry is followed by a ZIP64 data descriptor.
    Zip64DataDescriptor,
}

/// A ZIP reader which acts over a non-seekable source.
///
/// See the [module-level docs](.) for more information.
#[derive(Clone)]
pub struct ZipFileReader<S>(S);

impl<'a, R> ZipFileReader<Ready<Counting<R>>>
where
    R: AsyncBufRead + Unpin + 'a,
{
    /// Constructs a new ZIP reader from a non-seekable source.
    pub fn new(reader: R) -> Self {
        Self(Ready(Counting::new(reader)))
    }

    /// Opens the next entry for reading if the central directory hasn’t yet been reached.
    pub async fn next_without_entry(mut self) -> Result<Option<ZipFileReader<Reading<'a, Counting<R>, WithoutEntry>>>> {
        let file_offset = self.0 .0.bytes_read();
        let entry = match crate::base::read::lfh(&mut self.0 .0, file_offset).await? {
            Some(entry) => entry,
            None => return Ok(None),
        };

        let length = if entry.data_descriptor { u64::MAX } else { entry.compressed_size };
        let reader = ZipEntryReader::new_with_owned(self.0 .0, entry.compression, length);

        let suffix = if entry.data_descriptor {
            if entry.extra_fields.iter().any(|ef| ef.header_id() == HeaderId::ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD) {
                Some(Suffix::Zip64DataDescriptor)
            } else {
                Some(Suffix::DataDescriptor)
            }
        } else {
            None
        };

        Ok(Some(ZipFileReader(Reading(reader, suffix))))
    }

    /// Opens the next entry for reading if the central directory hasn’t yet been reached.
    pub async fn next_with_entry(mut self) -> Result<Option<ZipFileReader<Reading<'a, Counting<R>, WithEntry<'a>>>>> {
        let file_offset = self.0 .0.bytes_read();
        let entry = match crate::base::read::lfh(&mut self.0 .0, file_offset).await? {
            Some(entry) => entry,
            None => return Ok(None),
        };

        let length = if entry.data_descriptor { u64::MAX } else { entry.compressed_size };
        let reader = ZipEntryReader::new_with_owned(self.0 .0, entry.compression, length);

        let suffix = if entry.data_descriptor {
            if entry.extra_fields.iter().any(|ef| ef.header_id() == HeaderId::ZIP64_EXTENDED_INFORMATION_EXTRA_FIELD) {
                Some(Suffix::Zip64DataDescriptor)
            } else {
                Some(Suffix::DataDescriptor)
            }
        } else {
            None
        };

        Ok(Some(ZipFileReader(Reading(reader.into_with_entry_owned(entry), suffix))))
    }

    /// Consumes the `ZipFileReader` returning the original `reader`
    pub async fn into_inner(self) -> R {
        self.0 .0.into_inner()
    }

    /// Returns the file offset of the current reader.
    pub fn offset(&self) -> u64 {
        self.0 .0.bytes_read()
    }
}

#[cfg(feature = "tokio")]
impl<R> ZipFileReader<TokioReady<R>>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    /// Constructs a new tokio-specific ZIP reader from a non-seekable source.
    pub fn with_tokio(reader: R) -> ZipFileReader<TokioReady<R>> {
        Self(Ready(reader.compat()))
    }
}

type Next<R> = (Option<CombinedDataDescriptor>, ZipFileReader<Ready<R>>);

impl<'a, R, E> ZipFileReader<Reading<'a, R, E>>
where
    R: AsyncBufRead + Unpin,
{
    /// Returns an immutable reference to the inner entry reader.
    pub fn reader(&self) -> &ZipEntryReader<'a, R, E> {
        &self.0 .0
    }

    /// Returns a mutable reference to the inner entry reader.
    pub fn reader_mut(&mut self) -> &mut ZipEntryReader<'a, R, E> {
        &mut self.0 .0
    }

    /// Converts the reader back into the Ready state if EOF has been reached.
    pub async fn done(mut self) -> Result<Next<R>> {
        if self.0 .0.read(&mut [0; 1]).await? != 0 {
            return Err(ZipError::EOFNotReached);
        }

        let mut inner = self.0 .0.into_inner();

        let data_descriptor = match self.0 .1 {
            Some(Suffix::DataDescriptor) => {
                Some(CombinedDataDescriptor::from(DataDescriptor::from_reader(&mut inner).await?))
            }
            Some(Suffix::Zip64DataDescriptor) => {
                Some(CombinedDataDescriptor::from(Zip64DataDescriptor::from_reader(&mut inner).await?))
            }
            None => None,
        };

        let reader = ZipFileReader(Ready(inner));

        Ok((data_descriptor, reader))
    }

    /// Reads until EOF and converts the reader back into the Ready state.
    pub async fn skip(mut self) -> Result<Next<R>> {
        let mut buf = [0u8; 8192];
        while self.0 .0.read(&mut buf).await? != 0 {}
        let mut inner = self.0 .0.into_inner();

        let data_descriptor = match self.0 .1 {
            Some(Suffix::DataDescriptor) => {
                Some(CombinedDataDescriptor::from(DataDescriptor::from_reader(&mut inner).await?))
            }
            Some(Suffix::Zip64DataDescriptor) => {
                Some(CombinedDataDescriptor::from(Zip64DataDescriptor::from_reader(&mut inner).await?))
            }
            None => None,
        };

        let reader = ZipFileReader(Ready(inner));

        Ok((data_descriptor, reader))
    }
}
