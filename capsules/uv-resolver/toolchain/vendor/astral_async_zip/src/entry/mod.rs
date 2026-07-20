// Copyright (c) 2022 Harry [Majored] [hello@majored.pw]
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

pub mod builder;

use std::ops::Deref;

use futures_lite::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, SeekFrom};

use crate::base::read::{get_combined_sizes, get_zip64_extra_field};
use crate::entry::builder::ZipEntryBuilder;
use crate::error::{Result, ZipError};
use crate::spec::{
    attribute::AttributeCompatibility,
    consts::{LFH_LENGTH, LFH_SIGNATURE, NON_ZIP64_MAX_SIZE, SIGNATURE_LENGTH},
    header::{ExtraField, LocalFileHeader},
    parse::parse_extra_fields,
    Compression,
};
use crate::{string::ZipString, ZipDateTime};

/// An immutable store of data about a ZIP entry.
///
/// This type cannot be directly constructed so instead, the [`ZipEntryBuilder`] must be used. Internally this builder
/// stores a [`ZipEntry`] so conversions between these two types via the [`From`] implementations will be
/// non-allocating.
#[derive(Clone, Debug)]
pub struct ZipEntry {
    pub(crate) filename: ZipString,
    pub(crate) compression: Compression,
    #[cfg(any(
        feature = "deflate",
        feature = "bzip2",
        feature = "zstd",
        feature = "lzma",
        feature = "xz",
        feature = "deflate64"
    ))]
    pub(crate) compression_level: async_compression::Level,
    pub(crate) crc32: u32,
    pub(crate) uncompressed_size: u64,
    pub(crate) compressed_size: u64,
    pub(crate) attribute_compatibility: AttributeCompatibility,
    pub(crate) last_modification_date: ZipDateTime,
    pub(crate) internal_file_attribute: u16,
    pub(crate) external_file_attribute: u32,
    pub(crate) extra_fields: Vec<ExtraField>,
    pub(crate) comment: ZipString,
    pub(crate) data_descriptor: bool,
    pub(crate) file_offset: u64,
}

impl From<ZipEntryBuilder> for ZipEntry {
    fn from(builder: ZipEntryBuilder) -> Self {
        builder.0
    }
}

impl ZipEntry {
    pub(crate) fn new(filename: ZipString, compression: Compression) -> Self {
        ZipEntry {
            filename,
            compression,
            #[cfg(any(
                feature = "deflate",
                feature = "bzip2",
                feature = "zstd",
                feature = "lzma",
                feature = "xz",
                feature = "deflate64"
            ))]
            compression_level: async_compression::Level::Default,
            crc32: 0,
            uncompressed_size: 0,
            compressed_size: 0,
            attribute_compatibility: AttributeCompatibility::Unix,
            last_modification_date: ZipDateTime::default_for_write(),
            internal_file_attribute: 0,
            external_file_attribute: 0,
            extra_fields: Vec::new(),
            comment: String::new().into(),
            data_descriptor: false,
            file_offset: 0,
        }
    }

    /// Returns the entry's filename.
    ///
    /// ## Note
    /// This will return the raw filename stored during ZIP creation. If calling this method on entries retrieved from
    /// untrusted ZIP files, the filename should be sanitised before being used as a path to prevent [directory
    /// traversal attacks](https://en.wikipedia.org/wiki/Directory_traversal_attack).
    pub fn filename(&self) -> &ZipString {
        &self.filename
    }

    /// Returns the entry's compression method.
    pub fn compression(&self) -> Compression {
        self.compression
    }

    /// Returns the entry's CRC32 value.
    pub fn crc32(&self) -> u32 {
        self.crc32
    }

    /// Returns the entry's uncompressed size.
    pub fn uncompressed_size(&self) -> u64 {
        self.uncompressed_size
    }

    /// Returns the entry's compressed size.
    pub fn compressed_size(&self) -> u64 {
        self.compressed_size
    }

    /// Returns the entry's attribute's host compatibility.
    pub fn attribute_compatibility(&self) -> AttributeCompatibility {
        self.attribute_compatibility
    }

    /// Returns the entry's last modification time & date.
    pub fn last_modification_date(&self) -> &ZipDateTime {
        &self.last_modification_date
    }

    /// Returns the entry's internal file attribute.
    pub fn internal_file_attribute(&self) -> u16 {
        self.internal_file_attribute
    }

    /// Returns the entry's external file attribute
    pub fn external_file_attribute(&self) -> u32 {
        self.external_file_attribute
    }

    /// Returns the entry's extra field data.
    pub fn extra_fields(&self) -> &[ExtraField] {
        &self.extra_fields
    }

    /// Returns the entry's file comment.
    pub fn comment(&self) -> &ZipString {
        &self.comment
    }

    /// Returns the entry's integer-based UNIX permissions.
    ///
    /// # Note
    /// This will return None if the attribute host compatibility is not listed as Unix.
    pub fn unix_permissions(&self) -> Option<u16> {
        if !matches!(self.attribute_compatibility, AttributeCompatibility::Unix) {
            return None;
        }

        Some(((self.external_file_attribute) >> 16) as u16)
    }

    /// Returns whether or not the entry represents a directory.
    pub fn dir(&self) -> Result<bool> {
        Ok(self.filename.as_str()?.ends_with('/'))
    }

    /// Returns whether or not the entry has a data descriptor.
    pub fn data_descriptor(&self) -> bool {
        self.data_descriptor
    }

    /// Returns the file offset in bytes of the local file header for this entry.
    pub fn file_offset(&self) -> u64 {
        self.file_offset
    }
}

/// An immutable store of data about how a ZIP entry is stored within a specific archive.
///
/// Besides storing archive independent information like the size and timestamp it can also be used to query
/// information about how the entry is stored in an archive.
#[derive(Clone)]
pub struct StoredZipEntry {
    pub(crate) entry: ZipEntry,
    // pub(crate) general_purpose_flag: GeneralPurposeFlag,
    pub(crate) file_offset: u64,
    pub(crate) header_size: u64,
    pub(crate) data_end_boundary: u64,
}

impl StoredZipEntry {
    /// Returns the offset in bytes to where the header of the entry starts.
    pub fn header_offset(&self) -> u64 {
        self.file_offset
    }

    /// Returns the combined size in bytes of the header, the filename, and any extra fields.
    ///
    /// Note: This uses the extra field length stored in the central directory, which may differ from that stored in
    /// the local file header. See specification: <https://github.com/Majored/rs-async-zip/blob/main/SPECIFICATION.md#732>
    pub fn header_size(&self) -> u64 {
        self.header_size
    }

    /// Seek to the offset in bytes where the data of the entry starts.
    pub(crate) async fn seek_to_data_offset<R: AsyncRead + AsyncSeek + Unpin>(&self, mut reader: &mut R) -> Result<()> {
        // Seek to the header
        reader.seek(SeekFrom::Start(self.file_offset)).await?;

        // Check the signature
        let signature = {
            let mut buffer = [0; 4];
            reader.read_exact(&mut buffer).await?;
            u32::from_le_bytes(buffer)
        };

        match signature {
            LFH_SIGNATURE => (),
            actual => return Err(ZipError::UnexpectedHeaderError(actual, LFH_SIGNATURE)),
        };

        // Read and validate the local file header's trailing data.
        let header = LocalFileHeader::from_reader(&mut reader).await?;
        let data_start = self
            .file_offset
            .checked_add((SIGNATURE_LENGTH + LFH_LENGTH) as u64)
            .and_then(|offset| offset.checked_add(header.file_name_length as u64))
            .and_then(|offset| offset.checked_add(header.extra_field_length as u64))
            .ok_or(ZipError::InvalidEntryDataRange)?;
        let data_end = data_start.checked_add(self.entry.compressed_size()).ok_or(ZipError::InvalidEntryDataRange)?;
        if data_end > self.data_end_boundary {
            return Err(ZipError::EntryDataRangeOverlap {
                start: data_start,
                end: data_end,
                boundary: self.data_end_boundary,
            });
        }

        if header.flags.data_descriptor != self.entry.data_descriptor {
            return Err(ZipError::LocalFileHeaderDataDescriptorMismatch);
        }

        let local_filename = crate::base::read::io::read_bytes(&mut reader, header.file_name_length.into()).await?;
        if local_filename.as_slice() != self.entry.filename().as_bytes() {
            return Err(ZipError::LocalFileHeaderNameMismatch);
        }

        if !header.flags.data_descriptor
            && ((header.compressed_size != NON_ZIP64_MAX_SIZE
                && header.compressed_size as u64 != self.entry.compressed_size)
                || (header.uncompressed_size != NON_ZIP64_MAX_SIZE
                    && header.uncompressed_size as u64 != self.entry.uncompressed_size))
        {
            return Err(ZipError::LocalFileHeaderSizeMismatch);
        }

        let mut extra_field = vec![0; usize::from(header.extra_field_length)];
        reader.read_exact(&mut extra_field).await?;
        let extra_fields =
            parse_extra_fields(extra_field, header.uncompressed_size, header.compressed_size, None, None)?;
        let zip64_extra_field = get_zip64_extra_field(&extra_fields);

        if !header.flags.data_descriptor
            && zip64_extra_field.is_none()
            && extra_fields.is_empty()
            && (header.compressed_size == NON_ZIP64_MAX_SIZE || header.uncompressed_size == NON_ZIP64_MAX_SIZE)
        {
            return Err(ZipError::LocalFileHeaderSizeMismatch);
        }

        let (local_uncompressed_size, local_compressed_size) =
            get_combined_sizes(header.uncompressed_size, header.compressed_size, &zip64_extra_field)?;

        if !header.flags.data_descriptor
            && (local_compressed_size != self.entry.compressed_size
                || local_uncompressed_size != self.entry.uncompressed_size)
        {
            return Err(ZipError::LocalFileHeaderSizeMismatch);
        }

        Ok(())
    }
}

impl Deref for StoredZipEntry {
    type Target = ZipEntry;

    fn deref(&self) -> &Self::Target {
        &self.entry
    }
}
