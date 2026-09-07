// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

use crate::base::read::get_zip64_extra_field_mut;
use crate::base::write::compressed_writer::CompressedAsyncWriter;
use crate::base::write::get_or_put_info_zip_unicode_comment_extra_field_mut;
use crate::base::write::get_or_put_info_zip_unicode_path_extra_field_mut;
use crate::base::write::io::offset::AsyncOffsetWriter;
use crate::base::write::{CentralDirectoryEntry, ZipFileWriter};
use crate::entry::ZipEntry;
use crate::error::{Result, Zip64ErrorCase, ZipError};
use crate::spec::consts::{NON_ZIP64_MAX_NUM_FILES, NON_ZIP64_MAX_SIZE};
use crate::spec::extra_field::ExtraFieldAsBytes;
use crate::spec::header::{
    CentralDirectoryRecord, ExtraField, GeneralPurposeFlag, InfoZipUnicodeCommentExtraField,
    InfoZipUnicodePathExtraField, LocalFileHeader, Zip64ExtendedInformationExtraField,
};
use crate::StringEncoding;

use crc32fast::Hasher;
use futures_lite::io::{AsyncSeek, AsyncSeekExt, AsyncWrite, AsyncWriteExt, SeekFrom};
use std::io::Error;
use std::pin::Pin;
use std::task::{Context, Poll};

const ZIP64_VERSION_NEEDED: u16 = 45;

/// An entry writer which streams data to a seekable ZIP output.
///
/// Unlike [`EntryStreamWriter`](crate::base::write::EntryStreamWriter), this writer doesn't use
/// data descriptors. Instead, it writes a placeholder local file header, streams the entry data,
/// then seeks back and patches the header with the final CRC and sizes.
///
/// If the final compressed or uncompressed size requires Zip64 but no Zip64 size fields were
/// reserved up front, closing this writer will fail. Use [`ZipEntryBuilder::size`] to reserve those
/// fields when the size is known to exceed the non-Zip64 limit, or use
/// [`ZipFileWriter::write_entry_stream`] for fully unknown Zip64-sized entries.
///
/// [`ZipEntryBuilder::size`]: crate::ZipEntryBuilder::size
pub struct EntrySeekableWriter<'b, W: AsyncWrite + AsyncSeek + Unpin> {
    writer: AsyncOffsetWriter<CompressedAsyncWriter<'b, W>>,
    cd_entries: &'b mut Vec<CentralDirectoryEntry>,
    entry: ZipEntry,
    hasher: Hasher,
    lfh: LocalFileHeader,
    lfh_offset: u64,
    data_offset: u64,
    local_header_has_zip64_sizes: bool,
    force_no_zip64: bool,
    /// To write back to the original writer if Zip64 is required.
    is_zip64: &'b mut bool,
}

impl<'b, W: AsyncWrite + AsyncSeek + Unpin> EntrySeekableWriter<'b, W> {
    pub(crate) async fn from_raw(
        writer: &'b mut ZipFileWriter<W>,
        mut entry: ZipEntry,
    ) -> Result<EntrySeekableWriter<'b, W>> {
        if writer.force_no_zip64 && writer.cd_entries.len() >= NON_ZIP64_MAX_NUM_FILES as usize {
            return Err(ZipError::Zip64Needed(Zip64ErrorCase::TooManyFiles));
        }

        #[cfg(feature = "deflate64")]
        if matches!(entry.compression(), crate::Compression::Deflate64) {
            return Err(ZipError::FeatureNotSupported("Deflate64 writing"));
        }

        let lfh_offset = writer.writer.offset();
        let (lfh, local_header_has_zip64_sizes) = EntrySeekableWriter::write_lfh(writer, &mut entry).await?;
        let data_offset = writer.writer.offset();
        let force_no_zip64 = writer.force_no_zip64;

        let cd_entries = &mut writer.cd_entries;
        let is_zip64 = &mut writer.is_zip64;
        let writer = AsyncOffsetWriter::new(CompressedAsyncWriter::from_raw(&mut writer.writer, entry.compression())?);

        Ok(EntrySeekableWriter {
            writer,
            cd_entries,
            entry,
            lfh,
            lfh_offset,
            data_offset,
            local_header_has_zip64_sizes,
            hasher: Hasher::new(),
            force_no_zip64,
            is_zip64,
        })
    }

    async fn write_lfh(writer: &'b mut ZipFileWriter<W>, entry: &mut ZipEntry) -> Result<(LocalFileHeader, bool)> {
        let local_header_has_zip64_sizes =
            entry.uncompressed_size >= NON_ZIP64_MAX_SIZE as u64 || entry.compressed_size >= NON_ZIP64_MAX_SIZE as u64;
        if local_header_has_zip64_sizes {
            if writer.force_no_zip64 {
                return Err(ZipError::Zip64Needed(Zip64ErrorCase::LargeFile));
            }
            if !writer.is_zip64 {
                writer.is_zip64 = true;
            }
            // Reserve Zip64 size slots up front so the later header patch stays the same width.
            match get_zip64_extra_field_mut(&mut entry.extra_fields) {
                Some(zip64) => {
                    zip64.uncompressed_size = Some(entry.uncompressed_size);
                    zip64.compressed_size = Some(entry.compressed_size);
                }
                None => {
                    entry.extra_fields.push(ExtraField::Zip64ExtendedInformation(Zip64ExtendedInformationExtraField {
                        uncompressed_size: Some(entry.uncompressed_size),
                        compressed_size: Some(entry.compressed_size),
                        relative_header_offset: None,
                        disk_start_number: None,
                    }));
                }
            }
        }

        let utf8_without_alternative =
            entry.filename().is_utf8_without_alternative() && entry.comment().is_utf8_without_alternative();
        if !utf8_without_alternative {
            if matches!(entry.filename().encoding(), StringEncoding::Utf8) {
                let u_file_name = entry.filename().as_bytes().to_vec();
                if !u_file_name.is_empty() {
                    let basic_crc32 =
                        crc32fast::hash(entry.filename().alternative().unwrap_or_else(|| entry.filename().as_bytes()));
                    let upath_field = get_or_put_info_zip_unicode_path_extra_field_mut(entry.extra_fields.as_mut());
                    if let InfoZipUnicodePathExtraField::V1 { crc32, unicode } = upath_field {
                        *crc32 = basic_crc32;
                        *unicode = u_file_name;
                    }
                }
            }
            if matches!(entry.comment().encoding(), StringEncoding::Utf8) {
                let u_comment = entry.comment().as_bytes().to_vec();
                if !u_comment.is_empty() {
                    let basic_crc32 =
                        crc32fast::hash(entry.comment().alternative().unwrap_or_else(|| entry.comment().as_bytes()));
                    let ucom_field = get_or_put_info_zip_unicode_comment_extra_field_mut(entry.extra_fields.as_mut());
                    if let InfoZipUnicodeCommentExtraField::V1 { crc32, unicode } = ucom_field {
                        *crc32 = basic_crc32;
                        *unicode = u_comment;
                    }
                }
            }
        }

        let filename_basic = entry.filename().alternative().unwrap_or_else(|| entry.filename().as_bytes());

        let lfh = LocalFileHeader {
            compressed_size: if local_header_has_zip64_sizes { NON_ZIP64_MAX_SIZE } else { 0 },
            uncompressed_size: if local_header_has_zip64_sizes { NON_ZIP64_MAX_SIZE } else { 0 },
            compression: entry.compression().into(),
            crc: entry.crc32,
            extra_field_length: entry
                .extra_fields()
                .count_bytes()
                .try_into()
                .map_err(|_| ZipError::ExtraFieldTooLarge)?,
            file_name_length: filename_basic.len().try_into().map_err(|_| ZipError::FileNameTooLarge)?,
            mod_time: entry.last_modification_date().time,
            mod_date: entry.last_modification_date().date,
            version: crate::spec::version::as_needed_to_extract(entry),
            flags: GeneralPurposeFlag {
                data_descriptor: false,
                encrypted: false,
                strong_encryption: false,
                compressed_patched: false,
                filename_unicode: utf8_without_alternative,
            },
        };

        writer.writer.write_all(&crate::spec::consts::LFH_SIGNATURE.to_le_bytes()).await?;
        writer.writer.write_all(&lfh.as_slice()).await?;
        writer.writer.write_all(filename_basic).await?;
        writer.writer.write_all(&entry.extra_fields().as_bytes()).await?;

        Ok((lfh, local_header_has_zip64_sizes))
    }

    /// Consumes this entry writer and completes all closing tasks.
    ///
    /// This includes:
    /// - Finalising the CRC32 hash value for the written data.
    /// - Calculating the compressed and uncompressed byte sizes.
    /// - Seeking back to patch the local file header.
    /// - Constructing a central directory header.
    /// - Pushing that central directory header to the [`ZipFileWriter`]'s store.
    ///
    /// Failure to call this function before going out of scope would result in a corrupted ZIP file.
    pub async fn close(mut self) -> Result<()> {
        self.writer.close().await?;

        let crc = self.hasher.finalize();
        let uncompressed_size = self.writer.offset();
        let inner_writer = self.writer.into_inner().into_inner();
        let compressed_size = inner_writer.offset() - self.data_offset;
        let end_offset = inner_writer.offset();

        let requires_zip64_sizes =
            uncompressed_size >= NON_ZIP64_MAX_SIZE as u64 || compressed_size >= NON_ZIP64_MAX_SIZE as u64;
        let requires_zip64_offset = self.lfh_offset >= NON_ZIP64_MAX_SIZE as u64;

        if self.force_no_zip64 && (requires_zip64_sizes || requires_zip64_offset) {
            return Err(ZipError::Zip64Needed(Zip64ErrorCase::LargeFile));
        }
        if requires_zip64_sizes && !self.local_header_has_zip64_sizes {
            return Err(ZipError::Zip64Needed(Zip64ErrorCase::LargeFile));
        }

        let uses_zip64_sizes = requires_zip64_sizes || self.local_header_has_zip64_sizes;
        let uses_zip64_metadata = uses_zip64_sizes || requires_zip64_offset;
        if uses_zip64_sizes {
            if !*self.is_zip64 {
                *self.is_zip64 = true;
            }
            self.lfh.compressed_size = NON_ZIP64_MAX_SIZE;
            self.lfh.uncompressed_size = NON_ZIP64_MAX_SIZE;
            match get_zip64_extra_field_mut(&mut self.entry.extra_fields) {
                Some(zip64) => {
                    zip64.uncompressed_size = Some(uncompressed_size);
                    zip64.compressed_size = Some(compressed_size);
                }
                None => {
                    self.entry.extra_fields.push(ExtraField::Zip64ExtendedInformation(
                        Zip64ExtendedInformationExtraField {
                            uncompressed_size: Some(uncompressed_size),
                            compressed_size: Some(compressed_size),
                            relative_header_offset: None,
                            disk_start_number: None,
                        },
                    ));
                }
            }
        } else {
            self.lfh.compressed_size = compressed_size as u32;
            self.lfh.uncompressed_size = uncompressed_size as u32;
        }
        if uses_zip64_metadata {
            self.lfh.version = self.lfh.version.max(ZIP64_VERSION_NEEDED);
        }
        self.lfh.crc = crc;
        self.lfh.extra_field_length =
            self.entry.extra_fields().count_bytes().try_into().map_err(|_| ZipError::ExtraFieldTooLarge)?;

        let filename_basic = self.entry.filename().alternative().unwrap_or_else(|| self.entry.filename().as_bytes());
        let local_extra_fields = self.entry.extra_fields().as_bytes();

        inner_writer.seek(SeekFrom::Start(self.lfh_offset + crate::spec::consts::SIGNATURE_LENGTH as u64)).await?;
        inner_writer.write_all(&self.lfh.as_slice()).await?;
        inner_writer.write_all(filename_basic).await?;
        inner_writer.write_all(&local_extra_fields).await?;
        inner_writer.seek(SeekFrom::Start(end_offset)).await?;

        let lh_offset = if requires_zip64_offset {
            if !*self.is_zip64 {
                *self.is_zip64 = true;
            }
            match get_zip64_extra_field_mut(&mut self.entry.extra_fields) {
                Some(zip64) => {
                    zip64.relative_header_offset = Some(self.lfh_offset);
                }
                None => {
                    self.entry.extra_fields.push(ExtraField::Zip64ExtendedInformation(
                        Zip64ExtendedInformationExtraField {
                            uncompressed_size: None,
                            compressed_size: None,
                            relative_header_offset: Some(self.lfh_offset),
                            disk_start_number: None,
                        },
                    ));
                }
            }
            NON_ZIP64_MAX_SIZE
        } else {
            self.lfh_offset as u32
        };

        let comment_basic = self.entry.comment().alternative().unwrap_or_else(|| self.entry.comment().as_bytes());

        let cdh = CentralDirectoryRecord {
            compressed_size: self.lfh.compressed_size,
            uncompressed_size: self.lfh.uncompressed_size,
            crc,
            v_made_by: crate::spec::version::as_made_by(),
            v_needed: self.lfh.version,
            compression: self.lfh.compression,
            extra_field_length: self
                .entry
                .extra_fields()
                .count_bytes()
                .try_into()
                .map_err(|_| ZipError::ExtraFieldTooLarge)?,
            file_name_length: self.lfh.file_name_length,
            file_comment_length: comment_basic.len().try_into().map_err(|_| ZipError::CommentTooLarge)?,
            mod_time: self.lfh.mod_time,
            mod_date: self.lfh.mod_date,
            flags: self.lfh.flags,
            disk_start: 0,
            inter_attr: self.entry.internal_file_attribute(),
            exter_attr: self.entry.external_file_attribute(),
            lh_offset,
        };

        self.cd_entries.push(CentralDirectoryEntry { header: cdh, entry: self.entry });
        // Mark the archive as Zip64 once the central directory no longer fits in the legacy count field.
        if self.cd_entries.len() > NON_ZIP64_MAX_NUM_FILES as usize && !*self.is_zip64 {
            *self.is_zip64 = true;
        }

        Ok(())
    }
}

impl<'a, W: AsyncWrite + AsyncSeek + Unpin> AsyncWrite for EntrySeekableWriter<'a, W> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context, buf: &[u8]) -> Poll<std::result::Result<usize, Error>> {
        let poll = Pin::new(&mut self.writer).poll_write(cx, buf);

        if let Poll::Ready(Ok(written)) = poll {
            self.hasher.update(&buf[0..written]);
        }

        poll
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<std::result::Result<(), Error>> {
        Pin::new(&mut self.writer).poll_flush(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<std::result::Result<(), Error>> {
        Pin::new(&mut self.writer).poll_close(cx)
    }
}
