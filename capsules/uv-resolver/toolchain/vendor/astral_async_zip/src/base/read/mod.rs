// Copyright (c) 2022-2023 Harry [Majored] [hello@majored.pw]
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

//! A module which supports reading ZIP files.

pub mod mem;
pub mod seek;
pub mod stream;

pub mod cd;
mod counting;
pub(crate) mod io;

use crate::ZipString;
// Re-exported as part of the public API.
pub use crate::base::read::io::entry::WithEntry;
pub use crate::base::read::io::entry::WithoutEntry;
pub use crate::base::read::io::entry::ZipEntryReader;

use crate::date::ZipDateTime;
use crate::entry::{StoredZipEntry, ZipEntry};
use crate::error::{Result, ZipError};
use crate::file::ZipFile;
use crate::spec::attribute::AttributeCompatibility;
use crate::spec::consts::{CDDS_LENGTH, CDDS_SIGNATURE, CDH_LENGTH, LFH_LENGTH};
use crate::spec::consts::{
    CDH_SIGNATURE, LFH_SIGNATURE, NON_ZIP64_MAX_SIZE, SIGNATURE_LENGTH, ZIP64_EOCDL_LENGTH, ZIP64_EOCDR_SIGNATURE,
};
use crate::spec::header::InfoZipUnicodeCommentExtraField;
use crate::spec::header::InfoZipUnicodePathExtraField;
use crate::spec::header::{
    CentralDirectoryRecord, EndOfCentralDirectoryHeader, ExtraField, LocalFileHeader,
    Zip64EndOfCentralDirectoryLocator, Zip64EndOfCentralDirectoryRecord, Zip64ExtendedInformationExtraField,
};
use crate::spec::Compression;
use crate::string::StringEncoding;

use crate::base::read::io::CombinedCentralDirectoryRecord;
use crate::spec::parse::parse_extra_fields;

use futures_lite::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, BufReader, SeekFrom};

/// The max buffer size used when parsing the central directory, equal to 20MiB.
const MAX_CD_BUFFER_SIZE: usize = 20 * 1024 * 1024;
const MIN_CENTRAL_DIRECTORY_ENTRY_SIZE: u64 = (SIGNATURE_LENGTH + CDH_LENGTH) as u64;

pub(crate) async fn file<R>(mut reader: R) -> Result<ZipFile>
where
    R: AsyncRead + AsyncSeek + Unpin,
{
    // First find and parse the EOCDR.
    let eocdr_offset = crate::base::read::io::locator::eocdr(&mut reader).await?;
    let eocdr_record_offset = eocdr_offset.saturating_sub(SIGNATURE_LENGTH as u64);

    reader.seek(SeekFrom::Start(eocdr_offset)).await?;
    let eocdr = EndOfCentralDirectoryHeader::from_reader(&mut reader).await?;

    let comment = io::read_string(&mut reader, eocdr.file_comm_length.into(), crate::StringEncoding::Utf8).await?;

    // Check the 20 bytes before the EOCDR for the Zip64 EOCDL, plus an extra 4 bytes because the offset
    // does not include the signature. If the ECODL exists we are dealing with a Zip64 file.
    let (eocdr, zip64, central_directory_boundary) =
        match eocdr_offset.checked_sub(ZIP64_EOCDL_LENGTH + SIGNATURE_LENGTH as u64) {
            None => (CombinedCentralDirectoryRecord::try_from(&eocdr)?, false, eocdr_record_offset),
            Some(offset) => {
                reader.seek(SeekFrom::Start(offset)).await?;
                let zip64_locator = Zip64EndOfCentralDirectoryLocator::try_from_reader(&mut reader).await?;

                match zip64_locator {
                    Some(locator) => {
                        reader.seek(SeekFrom::Start(locator.relative_offset)).await?;
                        let signature = {
                            let mut buffer = [0; SIGNATURE_LENGTH];
                            reader.read_exact(&mut buffer).await?;
                            u32::from_le_bytes(buffer)
                        };
                        if signature != ZIP64_EOCDR_SIGNATURE {
                            return Err(ZipError::UnexpectedHeaderError(signature, ZIP64_EOCDR_SIGNATURE));
                        }
                        let zip64_eocdr = Zip64EndOfCentralDirectoryRecord::from_reader(&mut reader).await?;
                        validate_zip64_end_record_binding(&zip64_eocdr, locator.relative_offset, offset)?;
                        validate_zip64_entry_count(&zip64_eocdr, locator.relative_offset)?;
                        (CombinedCentralDirectoryRecord::combine(eocdr, zip64_eocdr)?, true, locator.relative_offset)
                    }
                    None => (CombinedCentralDirectoryRecord::try_from(&eocdr)?, false, eocdr_record_offset),
                }
            }
        };

    validate_central_directory_range(&eocdr, central_directory_boundary)?;

    // Outdated feature so unlikely to ever make it into this crate.
    if eocdr.disk_number != eocdr.disk_number_start_of_cd
        || eocdr.num_entries_in_directory != eocdr.num_entries_in_directory_on_disk
    {
        return Err(ZipError::FeatureNotSupported("Spanned/split files"));
    }

    // Find and parse the central directory.
    reader.seek(SeekFrom::Start(eocdr.offset_of_start_of_directory)).await?;

    // To avoid lots of small reads to `reader` when parsing the central directory, we use a BufReader that can read the whole central directory at once.
    // Because `eocdr.offset_of_start_of_directory` is a u64, we use MAX_CD_BUFFER_SIZE to prevent very large buffer sizes.
    let mut buf =
        BufReader::with_capacity(std::cmp::min(eocdr.offset_of_start_of_directory as _, MAX_CD_BUFFER_SIZE), reader);
    let mut entries = crate::base::read::cd(
        &mut buf,
        eocdr.num_entries_in_directory,
        eocdr.offset_of_start_of_directory,
        eocdr.directory_size,
        zip64,
    )
    .await?;
    validate_central_directory_binding(&eocdr, central_directory_boundary)?;
    assign_entry_data_boundaries(&mut entries, eocdr.offset_of_start_of_directory);

    Ok(ZipFile { entries, comment, zip64 })
}

fn validate_zip64_entry_count(zip64_eocdr: &Zip64EndOfCentralDirectoryRecord, zip64_eocdr_offset: u64) -> Result<()> {
    let minimum_central_directory_end = zip64_eocdr
        .num_entries_in_directory
        .saturating_mul(MIN_CENTRAL_DIRECTORY_ENTRY_SIZE)
        .saturating_add(zip64_eocdr.offset_of_start_of_directory);

    if zip64_eocdr_offset < minimum_central_directory_end {
        return Err(ZipError::InvalidCentralDirectoryEntryCount { entries: zip64_eocdr.num_entries_in_directory });
    }

    Ok(())
}

/// Ensures the ZIP64 end record occupies the entire span before its locator.
///
/// The record's size field excludes its signature and the size field itself, so both are added when deriving the
/// locator's expected offset.
fn validate_zip64_end_record_binding(
    zip64_eocdr: &Zip64EndOfCentralDirectoryRecord,
    zip64_eocdr_offset: u64,
    zip64_locator_offset: u64,
) -> Result<()> {
    let expected_locator_offset = zip64_eocdr_offset
        .checked_add(SIGNATURE_LENGTH as u64 + 8)
        .and_then(|offset| offset.checked_add(zip64_eocdr.size_of_zip64_end_of_cd_record))
        .ok_or(ZipError::InvalidZip64EndOfCentralDirectoryLocatorOffset(u64::MAX, zip64_locator_offset))?;

    if expected_locator_offset != zip64_locator_offset {
        return Err(ZipError::InvalidZip64EndOfCentralDirectoryLocatorOffset(
            expected_locator_offset,
            zip64_locator_offset,
        ));
    }

    Ok(())
}

/// Ensures the declared central-directory span ends exactly where the selected end record begins.
///
/// For a ZIP64 archive, `boundary` is the ZIP64 end record; otherwise it is the legacy end record.
fn validate_central_directory_binding(eocdr: &CombinedCentralDirectoryRecord, boundary: u64) -> Result<()> {
    let end = eocdr
        .offset_of_start_of_directory
        .checked_add(eocdr.directory_size)
        .ok_or(ZipError::InvalidCentralDirectoryBinding { directory_end: u64::MAX, end_record: boundary })?;

    if end != boundary {
        return Err(ZipError::InvalidCentralDirectoryBinding { directory_end: end, end_record: boundary });
    }

    Ok(())
}

/// Ensures the declared central-directory span does not overlap the selected end record.
fn validate_central_directory_range(eocdr: &CombinedCentralDirectoryRecord, boundary: u64) -> Result<()> {
    let start = eocdr.offset_of_start_of_directory;
    let end = start.checked_add(eocdr.directory_size).ok_or(ZipError::InvalidCentralDirectoryRange {
        start,
        end: u64::MAX,
        boundary,
    })?;

    if end > boundary {
        return Err(ZipError::InvalidCentralDirectoryRange { start, end, boundary });
    }

    Ok(())
}

fn cd_entry_capacity(num_of_entries: usize, directory_start: u64) -> Result<usize> {
    let directory_start = usize::try_from(directory_start).unwrap_or(usize::MAX);
    let capacity = if num_of_entries > directory_start { 0 } else { num_of_entries };

    if capacity.saturating_mul(std::mem::size_of::<StoredZipEntry>()) > isize::MAX as usize {
        return Err(ZipError::FeatureNotSupported("Oversized central directory"));
    }

    Ok(capacity)
}

fn assign_entry_data_boundaries(entries: &mut [StoredZipEntry], directory_start: u64) {
    let mut local_headers: Vec<_> = entries.iter().map(|entry| entry.file_offset).collect();
    local_headers.sort_unstable();

    for entry in entries {
        entry.data_end_boundary = local_headers
            .get(local_headers.partition_point(|offset| *offset <= entry.file_offset))
            .copied()
            .unwrap_or(directory_start)
            .min(directory_start);
    }
}

/// Parses exactly the central-directory span declared by the selected end record.
///
/// Once the declared entries have been read, only an optional central-directory digital-signature record may remain.
pub(crate) async fn cd<R>(
    reader: R,
    num_of_entries: u64,
    directory_start: u64,
    directory_size: u64,
    zip64: bool,
) -> Result<Vec<StoredZipEntry>>
where
    R: AsyncRead + Unpin,
{
    let claimed_entries = num_of_entries;
    let num_of_entries: usize = num_of_entries.try_into().map_err(|_| ZipError::TargetZip64NotSupported)?;
    let mut entries = Vec::with_capacity(cd_entry_capacity(num_of_entries, directory_start)?);
    let mut remaining_directory_size = directory_size;
    let mut reader = counting::Counting::new(reader);

    for _ in 0..num_of_entries {
        let entry = cd_record(&mut reader, zip64, &mut remaining_directory_size, claimed_entries).await?;
        entries.push(entry);
    }

    consume_central_directory_digital_signature(&mut reader, directory_size).await?;

    let actual = reader.bytes_read();
    if actual != directory_size {
        return Err(ZipError::InvalidCentralDirectorySize { expected: directory_size, actual });
    }

    Ok(entries)
}

/// Consumes an optional digital-signature record that exactly fills the unparsed central-directory span.
///
/// Returning without reading is valid only when the declared entries already consumed the full span. Other trailing
/// bytes, truncated records, and length claims that do not reach `directory_size` are rejected.
async fn consume_central_directory_digital_signature<R>(
    reader: &mut counting::Counting<R>,
    directory_size: u64,
) -> Result<()>
where
    R: AsyncRead + Unpin,
{
    let actual = reader.bytes_read();
    if actual >= directory_size {
        return Ok(());
    }

    let fixed_length = (SIGNATURE_LENGTH + CDDS_LENGTH) as u64;
    if directory_size - actual < fixed_length {
        return Err(ZipError::InvalidCentralDirectorySize { expected: directory_size, actual });
    }

    let mut signature = [0; SIGNATURE_LENGTH];
    reader.read_exact(&mut signature).await?;
    if u32::from_le_bytes(signature) != CDDS_SIGNATURE {
        return Err(ZipError::InvalidCentralDirectorySize { expected: directory_size, actual });
    }

    let mut length = [0; CDDS_LENGTH];
    reader.read_exact(&mut length).await?;
    let signature_length = u16::from_le_bytes(length) as u64;
    let Some(record_end) =
        actual.checked_add(fixed_length).and_then(|record_end| record_end.checked_add(signature_length))
    else {
        return Err(ZipError::InvalidCentralDirectorySize { expected: directory_size, actual: u64::MAX });
    };
    if record_end != directory_size {
        return Err(ZipError::InvalidCentralDirectorySize { expected: directory_size, actual: record_end });
    }

    io::skip_bytes(reader, signature_length).await?;
    Ok(())
}

pub(crate) fn get_zip64_extra_field(extra_fields: &[ExtraField]) -> Option<&Zip64ExtendedInformationExtraField> {
    for field in extra_fields {
        if let ExtraField::Zip64ExtendedInformation(zip64field) = field {
            return Some(zip64field);
        }
    }
    None
}

pub(crate) fn get_zip64_extra_field_mut(
    extra_fields: &mut [ExtraField],
) -> Option<&mut Zip64ExtendedInformationExtraField> {
    for field in extra_fields {
        if let ExtraField::Zip64ExtendedInformation(zip64field) = field {
            return Some(zip64field);
        }
    }
    None
}

pub(crate) fn get_combined_sizes(
    uncompressed_size: u32,
    compressed_size: u32,
    extra_field: &Option<&Zip64ExtendedInformationExtraField>,
) -> Result<(u64, u64)> {
    let mut uncompressed_size = uncompressed_size as u64;
    let mut compressed_size = compressed_size as u64;

    if uncompressed_size == NON_ZIP64_MAX_SIZE as u64 {
        uncompressed_size =
            extra_field.and_then(|field| field.uncompressed_size).ok_or(ZipError::Zip64ExtendedFieldIncomplete)?;
    }
    if compressed_size == NON_ZIP64_MAX_SIZE as u64 {
        compressed_size =
            extra_field.and_then(|field| field.compressed_size).ok_or(ZipError::Zip64ExtendedFieldIncomplete)?;
    }

    Ok((uncompressed_size, compressed_size))
}

pub(crate) async fn cd_record<R>(
    mut reader: R,
    _zip64: bool,
    remaining_directory_size: &mut u64,
    claimed_entries: u64,
) -> Result<StoredZipEntry>
where
    R: AsyncRead + Unpin,
{
    if *remaining_directory_size < MIN_CENTRAL_DIRECTORY_ENTRY_SIZE {
        return Err(ZipError::InvalidCentralDirectoryEntryCount { entries: claimed_entries });
    }

    crate::utils::assert_signature(&mut reader, CDH_SIGNATURE).await?;

    let header = CentralDirectoryRecord::from_reader(&mut reader).await?;
    let central_directory_entry_size = MIN_CENTRAL_DIRECTORY_ENTRY_SIZE
        + header.file_name_length as u64
        + header.extra_field_length as u64
        + header.file_comment_length as u64;
    if *remaining_directory_size < central_directory_entry_size {
        return Err(ZipError::InvalidCentralDirectoryEntryCount { entries: claimed_entries });
    }
    *remaining_directory_size -= central_directory_entry_size;

    let header_size = (SIGNATURE_LENGTH + LFH_LENGTH) as u64;
    let trailing_size = header.file_name_length as u64 + header.extra_field_length as u64;
    let filename_basic = io::read_bytes(&mut reader, header.file_name_length.into()).await?;
    let compression = Compression::try_from(header.compression)?;
    let extra_field = io::read_bytes(&mut reader, header.extra_field_length.into()).await?;
    let extra_fields = parse_extra_fields(
        extra_field,
        header.uncompressed_size,
        header.compressed_size,
        Some(header.lh_offset),
        Some(header.disk_start),
    )?;
    let comment_basic = io::read_bytes(reader, header.file_comment_length.into()).await?;

    let zip64_extra_field = get_zip64_extra_field(&extra_fields);
    let (uncompressed_size, compressed_size) =
        get_combined_sizes(header.uncompressed_size, header.compressed_size, &zip64_extra_field)?;

    let mut file_offset = header.lh_offset as u64;
    if let Some(zip64_extra_field) = zip64_extra_field {
        if file_offset == NON_ZIP64_MAX_SIZE as u64 {
            if let Some(offset) = zip64_extra_field.relative_header_offset {
                file_offset = offset;
            }
        }
    }

    let filename = detect_filename(filename_basic, header.flags.filename_unicode, extra_fields.as_ref())?;
    let comment = detect_comment(comment_basic, header.flags.filename_unicode, extra_fields.as_ref());

    let entry = ZipEntry {
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
        attribute_compatibility: AttributeCompatibility::Unix,
        // FIXME: Default to Unix for the moment
        crc32: header.crc,
        uncompressed_size,
        compressed_size,
        last_modification_date: ZipDateTime { date: header.mod_date, time: header.mod_time },
        internal_file_attribute: header.inter_attr,
        external_file_attribute: header.exter_attr,
        extra_fields,
        comment,
        data_descriptor: header.flags.data_descriptor,
        file_offset,
    };

    Ok(StoredZipEntry { entry, file_offset, header_size: header_size + trailing_size, data_end_boundary: u64::MAX })
}

pub(crate) async fn lfh<R>(mut reader: R, file_offset: u64) -> Result<Option<ZipEntry>>
where
    R: AsyncRead + Unpin,
{
    let signature = {
        let mut buffer = [0; 4];
        reader.read_exact(&mut buffer).await?;
        u32::from_le_bytes(buffer)
    };
    match signature {
        actual if actual == LFH_SIGNATURE => (),
        actual if actual == CDH_SIGNATURE => return Ok(None),
        actual => return Err(ZipError::UnexpectedHeaderError(actual, LFH_SIGNATURE)),
    };

    let header = LocalFileHeader::from_reader(&mut reader).await?;
    let filename_basic = io::read_bytes(&mut reader, header.file_name_length.into()).await?;
    let compression = Compression::try_from(header.compression)?;
    let extra_field = io::read_bytes(&mut reader, header.extra_field_length.into()).await?;
    let extra_fields = parse_extra_fields(extra_field, header.uncompressed_size, header.compressed_size, None, None)?;

    let zip64_extra_field = get_zip64_extra_field(&extra_fields);
    let (uncompressed_size, compressed_size) =
        get_combined_sizes(header.uncompressed_size, header.compressed_size, &zip64_extra_field)?;

    if header.flags.data_descriptor && compression == Compression::Stored {
        return Err(ZipError::FeatureNotSupported(
            "stream reading entries with data descriptors & Stored compression mode",
        ));
    }
    let filename = detect_filename(filename_basic, header.flags.filename_unicode, extra_fields.as_ref())?;

    let entry = ZipEntry {
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
        attribute_compatibility: AttributeCompatibility::Unix,
        // FIXME: Default to Unix for the moment
        crc32: header.crc,
        uncompressed_size,
        compressed_size,
        last_modification_date: ZipDateTime { date: header.mod_date, time: header.mod_time },
        internal_file_attribute: 0,
        external_file_attribute: 0,
        extra_fields,
        comment: String::new().into(),
        data_descriptor: header.flags.data_descriptor,
        file_offset,
    };

    Ok(Some(entry))
}

fn detect_comment(basic: Vec<u8>, basic_is_utf8: bool, extra_fields: &[ExtraField]) -> ZipString {
    if basic_is_utf8 {
        ZipString::new(basic, StringEncoding::Utf8)
    } else {
        let unicode_extra = extra_fields.iter().find_map(|field| match field {
            ExtraField::InfoZipUnicodeComment(InfoZipUnicodeCommentExtraField::V1 { crc32, unicode }) => {
                if *crc32 == crc32fast::hash(&basic) {
                    Some(std::string::String::from_utf8(unicode.clone()))
                } else {
                    None
                }
            }
            _ => None,
        });
        if let Some(Ok(s)) = unicode_extra {
            ZipString::new_with_alternative(s, basic)
        } else {
            // Do not treat as UTF-8 if UTF-8 flags are not set,
            // some string in MBCS may be valid UTF-8 in form, but they are not in truth.
            if basic.is_ascii() {
                // SAFETY:
                // a valid ASCII string is always a valid UTF-8 string
                unsafe { std::string::String::from_utf8_unchecked(basic).into() }
            } else {
                ZipString::new(basic, StringEncoding::Raw)
            }
        }
    }
}

fn detect_filename(basic: Vec<u8>, basic_is_utf8: bool, extra_fields: &[ExtraField]) -> Result<ZipString> {
    let unicode_extra = extra_fields.iter().find_map(|field| match field {
        ExtraField::InfoZipUnicodePath(InfoZipUnicodePathExtraField::V1 { crc32, unicode }) => {
            if !unicode.is_empty() && *crc32 == crc32fast::hash(&basic) {
                Some(std::string::String::from_utf8(unicode.clone()))
            } else {
                None
            }
        }
        _ => None,
    });
    if basic.contains(&0) {
        return Err(ZipError::FileNameContainsNul { filename: basic });
    }
    if let Some(Ok(filename)) = unicode_extra.as_ref() {
        if filename.contains('\0') {
            return Err(ZipError::FileNameContainsNul { filename: filename.as_bytes().to_vec() });
        }
    }
    if let Some(unicode_extra) = unicode_extra {
        let unicode = unicode_extra.map_err(|_| ZipError::InfoZipUnicodePathFieldInvalidUtf8)?;
        Ok(ZipString::new_with_alternative(unicode, basic))
    } else if basic_is_utf8 {
        Ok(ZipString::new(basic, StringEncoding::Utf8))
    } else {
        // Do not treat as UTF-8 if UTF-8 flags are not set,
        // some string in MBCS may be valid UTF-8 in form, but they are not in truth.
        if basic.is_ascii() {
            // SAFETY:
            // a valid ASCII string is always a valid UTF-8 string
            Ok(unsafe { std::string::String::from_utf8_unchecked(basic).into() })
        } else {
            Ok(ZipString::new(basic, StringEncoding::Raw))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_matching_unicode_path_extra_field_is_rejected() {
        let basic = b"basic.txt".to_vec();
        let fields = [ExtraField::InfoZipUnicodePath(InfoZipUnicodePathExtraField::V1 {
            crc32: crc32fast::hash(&basic),
            unicode: vec![0xFF],
        })];

        assert!(matches!(detect_filename(basic, false, &fields), Err(ZipError::InfoZipUnicodePathFieldInvalidUtf8)));
    }

    #[test]
    fn invalid_non_matching_unicode_path_extra_field_is_ignored() {
        let basic = b"basic.txt".to_vec();
        let fields =
            [ExtraField::InfoZipUnicodePath(InfoZipUnicodePathExtraField::V1 { crc32: 0, unicode: vec![0xFF] })];

        assert_eq!(detect_filename(basic, false, &fields).unwrap().as_str().unwrap(), "basic.txt");
    }
}
