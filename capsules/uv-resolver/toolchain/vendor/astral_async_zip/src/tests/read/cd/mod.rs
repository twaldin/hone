// Copyright (c) 2025 Astral
// MIT License (https://github.com/astral-sh/rs-async-zip/blob/main/LICENSE)

use crate::spec::version::MAX_SUPPORTED_EXTRACT_VERSION;

const UNSUPPORTED_EXTRACT_VERSION: u16 = MAX_SUPPORTED_EXTRACT_VERSION + 1;

fn diff_092_data(local_version: u16, central_version: u16) -> Vec<u8> {
    use crate::spec::consts::CDH_SIGNATURE;

    let mut data = include_bytes!("diff-092-sample.zip").to_vec();
    data[4..6].copy_from_slice(&local_version.to_le_bytes());

    let signature = CDH_SIGNATURE.to_le_bytes();
    let offset = data.windows(signature.len()).position(|window| window == signature).unwrap();
    data[offset + 6..offset + 8].copy_from_slice(&central_version.to_le_bytes());
    data
}

fn central_directory_offset(data: &[u8]) -> usize {
    use crate::spec::consts::CDH_SIGNATURE;

    let signature = CDH_SIGNATURE.to_le_bytes();
    data.windows(signature.len()).position(|window| window == signature).unwrap()
}

#[cfg(feature = "deflate")]
#[tokio::test]
async fn test_nonempty_cd_comment() {
    use futures_lite::io::Cursor;

    use crate::base::read::cd::{CentralDirectoryReader, Entry};
    use crate::base::read::stream::ZipFileReader;
    use crate::tests::init_logger;

    init_logger();

    let data = include_bytes!("nonempty_cd_comment.zip").to_vec();

    let mut cursor = Cursor::new(data);

    let mut zip = ZipFileReader::new(&mut cursor);

    // Move forward through the ZIP's local file entries to reach the CD.
    // We do this instead of using the EOCDR locator to mimic a streaming read.
    let mut offset = 0;
    while let Some(entry) = zip.next_with_entry().await.unwrap() {
        (.., zip) = entry.skip().await.unwrap();
        offset = zip.offset();
    }

    let mut cdr = CentralDirectoryReader::new(&mut cursor, offset);

    let Entry::CentralDirectoryEntry(_) = cdr.next().await.unwrap() else {
        panic!("expected a central directory entry");
    };

    // Our position matches the end of the CD entry, including its
    // non-empty comment field.
    assert_eq!(cursor.position(), 0x2c + 52);
}

#[tokio::test]
async fn test_zip64_central_sentinel_requires_recognized_extra_field() {
    use futures_lite::io::Cursor;

    use crate::base::read::cd::CentralDirectoryReader;
    use crate::error::ZipError;
    use crate::spec::consts::CDH_SIGNATURE;

    let mut data = include_bytes!("../zip64/diff-002-sample.zip").to_vec();
    let signature_offset =
        data.windows(4).position(|bytes| bytes == CDH_SIGNATURE.to_le_bytes()).expect("central directory header");
    let filename_length =
        u16::from_le_bytes(data[signature_offset + 28..signature_offset + 30].try_into().unwrap()) as usize;
    let extra_field_offset = signature_offset + 46 + filename_length;
    assert_eq!(&data[extra_field_offset..extra_field_offset + 2], &1_u16.to_le_bytes());
    data[extra_field_offset..extra_field_offset + 2].copy_from_slice(&0xf00d_u16.to_le_bytes());

    let mut cursor = Cursor::new(&data[signature_offset + 4..]);
    let mut reader = CentralDirectoryReader::new(&mut cursor, signature_offset as u64);
    let err = match reader.next().await {
        Ok(_) => panic!("expected missing ZIP64 extended field"),
        Err(err) => err,
    };
    assert!(matches!(err, ZipError::Zip64ExtendedFieldIncomplete));
}

#[tokio::test]
async fn test_local_header_name_must_match_central_directory_name() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let data = include_bytes!("diff-004-sample.zip").to_vec();
    let reader = ZipFileReader::new(data).await.unwrap();

    let Err(err) = reader.reader_without_entry(0).await else {
        panic!("expected local header name mismatch");
    };
    assert!(matches!(err, ZipError::LocalFileHeaderNameMismatch));
}

#[tokio::test]
async fn test_strong_encryption_entries_are_rejected() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let data = include_bytes!("diff-089-sample.zip").to_vec();

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected strong encryption to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("strong encryption")));
}

#[tokio::test]
async fn test_streamed_central_strong_encryption_entries_are_rejected() {
    use futures_lite::io::Cursor;

    use crate::base::read::cd::CentralDirectoryReader;
    use crate::error::ZipError;

    // `CentralDirectoryReader` starts immediately after the first central-directory signature.
    let mut record = [0; 42];
    record[4..6].copy_from_slice(&0x0040_u16.to_le_bytes());
    let mut reader = CentralDirectoryReader::new(Cursor::new(record), 0);

    let Err(err) = reader.next().await else {
        panic!("expected streamed strong encryption to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("strong encryption")));
}

fn strong_encryption_only_in_local_header() -> Vec<u8> {
    use crate::spec::consts::{CDH_SIGNATURE, LFH_SIGNATURE};

    let mut data = include_bytes!("diff-089-sample.zip").to_vec();
    let local_header = data.windows(4).position(|bytes| bytes == LFH_SIGNATURE.to_le_bytes()).unwrap();
    let central_header = data.windows(4).position(|bytes| bytes == CDH_SIGNATURE.to_le_bytes()).unwrap();

    // Set the strong-encryption flag in the local header, but clear it in the central-directory
    // record so that local-header parsing is solely responsible for rejecting the entry. Use
    // stored compression in both headers so this fixture works without compression features.
    data[local_header + 6..local_header + 8].copy_from_slice(&0x0040_u16.to_le_bytes());
    data[local_header + 8..local_header + 10].copy_from_slice(&0_u16.to_le_bytes());
    data[central_header + 8..central_header + 10].copy_from_slice(&0_u16.to_le_bytes());
    data[central_header + 10..central_header + 12].copy_from_slice(&0_u16.to_le_bytes());

    data
}

#[tokio::test]
async fn test_streamed_local_strong_encryption_entries_are_rejected() {
    use futures_lite::io::Cursor;

    use crate::base::read::stream::ZipFileReader;
    use crate::error::ZipError;

    let reader = ZipFileReader::new(Cursor::new(strong_encryption_only_in_local_header()));

    let Err(err) = reader.next_without_entry().await else {
        panic!("expected local strong encryption to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("strong encryption")));
}

#[tokio::test]
async fn test_seekable_local_strong_encryption_entries_are_rejected() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let reader = ZipFileReader::new(strong_encryption_only_in_local_header()).await.unwrap();

    let Err(err) = reader.reader_without_entry(0).await else {
        panic!("expected local strong encryption to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("strong encryption")));
}

#[tokio::test]
async fn test_archive_rejects_unsupported_central_directory_extract_versions() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let data = diff_092_data(20, UNSUPPORTED_EXTRACT_VERSION);

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected extract version to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("zip file version > 6.3")));
}

#[cfg(feature = "deflate")]
#[tokio::test]
async fn test_archive_accepts_nonzero_reserved_extract_version_bytes() {
    use crate::base::read::mem::ZipFileReader;

    let version = 3 << 8 | 20;
    let data = diff_092_data(version, version);

    let reader = ZipFileReader::new(data).await.unwrap();
    reader.reader_without_entry(0).await.unwrap();
}

#[cfg(feature = "deflate")]
#[tokio::test]
async fn test_stream_rejects_unsupported_local_extract_versions() {
    use crate::base::read::stream::ZipFileReader;
    use crate::error::ZipError;

    let data = diff_092_data(UNSUPPORTED_EXTRACT_VERSION, 20);

    let Err(err) = ZipFileReader::new(data.as_slice()).next_with_entry().await else {
        panic!("expected local extract version to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("zip file version > 6.3")));
}

#[cfg(feature = "deflate")]
#[tokio::test]
async fn test_stream_accepts_maximum_supported_local_extract_version() {
    use crate::base::read::stream::ZipFileReader;

    let data = diff_092_data(MAX_SUPPORTED_EXTRACT_VERSION, 20);

    assert!(ZipFileReader::new(data.as_slice()).next_with_entry().await.unwrap().is_some());
}

#[tokio::test]
async fn test_incremental_central_directory_reader_rejects_unsupported_extract_versions() {
    use futures_lite::io::Cursor;

    use crate::base::read::cd::CentralDirectoryReader;
    use crate::error::ZipError;

    let data = diff_092_data(20, UNSUPPORTED_EXTRACT_VERSION);
    let offset = central_directory_offset(&data);
    let mut cursor = Cursor::new(&data[offset + 4..]);
    let mut cdr = CentralDirectoryReader::new(&mut cursor, offset as u64);

    let Err(err) = cdr.next().await else {
        panic!("expected extract version to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("zip file version > 6.3")));
}

#[tokio::test]
async fn test_incremental_central_directory_reader_accepts_maximum_supported_extract_version() {
    use futures_lite::io::Cursor;

    use crate::base::read::cd::{CentralDirectoryReader, Entry};

    let data = diff_092_data(20, MAX_SUPPORTED_EXTRACT_VERSION);
    let offset = central_directory_offset(&data);
    let mut cursor = Cursor::new(&data[offset + 4..]);
    let mut cdr = CentralDirectoryReader::new(&mut cursor, offset as u64);

    assert!(matches!(cdr.next().await.unwrap(), Entry::CentralDirectoryEntry(_)));
}

/// Verifies that a streamed read rejects a physical central-directory entry when the ordinary
/// EOCD record declares a central-directory byte span one byte shorter than the actual entry.
#[tokio::test]
async fn test_streamed_central_directory_size_must_match_end_record() {
    use futures_lite::io::Cursor;

    use crate::base::read::cd::{CentralDirectoryReader, Entry};
    use crate::base::read::stream::ZipFileReader;
    use crate::error::ZipError;

    let data = include_bytes!("diff-094-sample.zip").to_vec();
    let mut cursor = Cursor::new(data);
    let mut zip = ZipFileReader::new(&mut cursor);

    let mut offset = 0;
    while let Some(entry) = zip.next_with_entry().await.unwrap() {
        (.., zip) = entry.skip().await.unwrap();
        offset = zip.offset();
    }

    let mut cdr = CentralDirectoryReader::new(&mut cursor, offset);
    assert!(matches!(cdr.next().await.unwrap(), Entry::CentralDirectoryEntry(_)));

    let Err(err) = cdr.next().await else {
        panic!("expected central-directory size mismatch");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectorySize { .. }));
}

/// Verifies that a streamed read rejects a physical central-directory entry when the ordinary
/// EOCD record declares a zero-byte central directory.
#[tokio::test]
async fn test_streamed_zero_central_directory_size_must_match_end_record() {
    use futures_lite::io::Cursor;

    use crate::base::read::cd::{CentralDirectoryReader, Entry};
    use crate::base::read::stream::ZipFileReader;
    use crate::error::ZipError;

    let data = include_bytes!("zero-central-directory-size.zip").to_vec();

    let mut cursor = Cursor::new(data);
    let mut zip = ZipFileReader::new(&mut cursor);

    let mut offset = 0;
    while let Some(entry) = zip.next_with_entry().await.unwrap() {
        (.., zip) = entry.skip().await.unwrap();
        offset = zip.offset();
    }

    let mut cdr = CentralDirectoryReader::new(&mut cursor, offset);
    assert!(matches!(cdr.next().await.unwrap(), Entry::CentralDirectoryEntry(_)));

    let Err(err) = cdr.next().await else {
        panic!("expected central-directory size mismatch");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectorySize { expected: 0, .. }));
}

#[tokio::test]
async fn test_streamed_zip64_central_directory_size_must_match_end_record() {
    use futures_lite::io::Cursor;

    use crate::base::read::cd::{CentralDirectoryReader, Entry};
    use crate::base::read::stream::ZipFileReader;
    use crate::error::ZipError;
    use crate::spec::consts::{EOCDR_SIGNATURE, ZIP64_EOCDR_SIGNATURE};

    let mut data = include_bytes!("../zip64/zip64.zip").to_vec();
    let zip64_eocdr_offset = data.windows(4).position(|bytes| bytes == ZIP64_EOCDR_SIGNATURE.to_le_bytes()).unwrap();
    data[zip64_eocdr_offset + 24..zip64_eocdr_offset + 40].fill(0);
    data[zip64_eocdr_offset + 40..zip64_eocdr_offset + 48].copy_from_slice(&0_u64.to_le_bytes());
    let eocdr_offset = data.windows(4).position(|bytes| bytes == EOCDR_SIGNATURE.to_le_bytes()).unwrap();
    data[eocdr_offset + 8..eocdr_offset + 12].fill(0xff);
    data[eocdr_offset + 12..eocdr_offset + 16].copy_from_slice(&u32::MAX.to_le_bytes());

    let mut cursor = Cursor::new(data);
    let mut zip = ZipFileReader::new(&mut cursor);

    let mut offset = 0;
    while let Some(entry) = zip.next_with_entry().await.unwrap() {
        (.., zip) = entry.skip().await.unwrap();
        offset = zip.offset();
    }

    let mut cdr = CentralDirectoryReader::new(&mut cursor, offset);
    assert!(matches!(cdr.next().await.unwrap(), Entry::CentralDirectoryEntry(_)));

    let Err(err) = cdr.next().await else {
        panic!("expected ZIP64 central-directory size mismatch");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectorySize { expected: 0, .. }));
}

#[tokio::test]
async fn test_nul_filenames_are_rejected() {
    use futures_lite::io::Cursor;

    use crate::base::read::mem;
    use crate::base::read::stream::ZipFileReader;
    use crate::error::ZipError;

    let data = include_bytes!("diff-096-sample.zip").to_vec();

    let Err(err) = mem::ZipFileReader::new(data.clone()).await else {
        panic!("expected an embedded NUL filename to be rejected");
    };
    let ZipError::FileNameContainsNul { filename } = err else {
        panic!("expected an embedded NUL filename error");
    };
    assert!(filename.contains(&0));

    let mut zip = ZipFileReader::new(Cursor::new(data));
    loop {
        match zip.next_with_entry().await {
            Err(err) => {
                let ZipError::FileNameContainsNul { filename } = err else {
                    panic!("expected an embedded NUL filename error");
                };
                assert!(filename.contains(&0));
                break;
            }
            Ok(Some(entry)) => {
                (.., zip) = entry.skip().await.unwrap();
            }
            Ok(None) => panic!("expected an embedded NUL filename to be rejected while streaming"),
        }
    }
}

fn empty_stored_zip(
    local_flags: u16,
    local_compressed_size: u32,
    local_uncompressed_size: u32,
    local_extra: &[u8],
    central_flags: u16,
    central_compressed_size: u32,
    central_uncompressed_size: u32,
) -> Vec<u8> {
    let mut zip = Vec::new();

    // Local file header for an empty stored entry named "a".
    zip.extend_from_slice(b"PK\x03\x04");
    zip.extend_from_slice(&20_u16.to_le_bytes());
    zip.extend_from_slice(&local_flags.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u32.to_le_bytes());
    zip.extend_from_slice(&local_compressed_size.to_le_bytes());
    zip.extend_from_slice(&local_uncompressed_size.to_le_bytes());
    zip.extend_from_slice(&1_u16.to_le_bytes());
    zip.extend_from_slice(&(local_extra.len() as u16).to_le_bytes());
    zip.push(b'a');
    zip.extend_from_slice(local_extra);

    let central_directory_offset = zip.len() as u32;

    zip.extend_from_slice(b"PK\x01\x02");
    zip.extend_from_slice(&20_u16.to_le_bytes());
    zip.extend_from_slice(&20_u16.to_le_bytes());
    zip.extend_from_slice(&central_flags.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u32.to_le_bytes());
    zip.extend_from_slice(&central_compressed_size.to_le_bytes());
    zip.extend_from_slice(&central_uncompressed_size.to_le_bytes());
    zip.extend_from_slice(&1_u16.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u32.to_le_bytes());
    zip.extend_from_slice(&0_u32.to_le_bytes());
    zip.push(b'a');

    let central_directory_size = zip.len() as u32 - central_directory_offset;

    zip.extend_from_slice(b"PK\x05\x06");
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());
    zip.extend_from_slice(&1_u16.to_le_bytes());
    zip.extend_from_slice(&1_u16.to_le_bytes());
    zip.extend_from_slice(&central_directory_size.to_le_bytes());
    zip.extend_from_slice(&central_directory_offset.to_le_bytes());
    zip.extend_from_slice(&0_u16.to_le_bytes());

    zip
}

fn zip64_sizes_extra_field(compressed_size: u64, uncompressed_size: u64) -> Vec<u8> {
    let mut extra = Vec::new();
    extra.extend_from_slice(&1_u16.to_le_bytes());
    extra.extend_from_slice(&16_u16.to_le_bytes());
    extra.extend_from_slice(&uncompressed_size.to_le_bytes());
    extra.extend_from_slice(&compressed_size.to_le_bytes());
    extra
}

#[tokio::test]
async fn test_local_header_sizes_must_match_central_directory() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let reader = ZipFileReader::new(empty_stored_zip(0, 1, 1, &[], 0, 0, 0)).await.unwrap();
    let Err(err) = reader.reader_without_entry(0).await else {
        panic!("expected local header sizes to be rejected");
    };

    assert!(matches!(err, ZipError::LocalFileHeaderSizeMismatch));
}

#[tokio::test]
async fn test_local_header_descriptor_flag_must_match_central_directory() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let reader = ZipFileReader::new(empty_stored_zip(1 << 3, 0, 0, &[], 0, 0, 0)).await.unwrap();
    let Err(err) = reader.reader_without_entry(0).await else {
        panic!("expected local header descriptor flag to be rejected");
    };

    assert!(matches!(err, ZipError::LocalFileHeaderDataDescriptorMismatch));
}

#[tokio::test]
async fn test_each_concrete_local_size_must_match_central_directory() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let reader = ZipFileReader::new(empty_stored_zip(0, u32::MAX, 1, &[], 0, 0, 0)).await.unwrap();
    let Err(err) = reader.reader_without_entry(0).await else {
        panic!("expected the concrete local uncompressed size to be rejected");
    };

    assert!(matches!(err, ZipError::LocalFileHeaderSizeMismatch));
}

#[tokio::test]
async fn test_local_zip64_sizes_must_match_central_directory() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let local_extra = zip64_sizes_extra_field(1, 0);
    let reader = ZipFileReader::new(empty_stored_zip(0, u32::MAX, u32::MAX, &local_extra, 0, 0, 0)).await.unwrap();
    let Err(err) = reader.reader_without_entry(0).await else {
        panic!("expected local ZIP64 sizes to be rejected");
    };

    assert!(matches!(err, ZipError::LocalFileHeaderSizeMismatch));
}

#[tokio::test]
async fn test_local_zip64_sizes_must_have_overrides() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let reader = ZipFileReader::new(empty_stored_zip(0, u32::MAX, u32::MAX, &[], 0, 0, 0)).await.unwrap();
    let Err(err) = reader.reader_without_entry(0).await else {
        panic!("expected absent local ZIP64 sizes to be rejected");
    };

    assert!(matches!(err, ZipError::LocalFileHeaderSizeMismatch));
}

#[tokio::test]
async fn test_each_local_zip64_size_must_have_an_override() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    for (compressed_size, uncompressed_size) in [(u32::MAX, 0), (0, u32::MAX)] {
        let reader =
            ZipFileReader::new(empty_stored_zip(0, compressed_size, uncompressed_size, &[], 0, 0, 0)).await.unwrap();
        let Err(err) = reader.reader_without_entry(0).await else {
            panic!("expected absent local ZIP64 size to be rejected");
        };

        assert!(matches!(err, ZipError::LocalFileHeaderSizeMismatch));
    }
}

#[tokio::test]
async fn test_central_directory_encryption_is_rejected() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let data = include_bytes!("diff-085-sample.zip").to_vec();

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected central-directory encryption to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("encryption")));
}

#[tokio::test]
async fn test_compressed_patched_entries_are_rejected() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let data = include_bytes!("diff-088-sample.zip").to_vec();

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected compressed patched data to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("compressed patched data")));
}

#[tokio::test]
async fn test_stream_with_entry_rejects_compressed_patched_local_headers() {
    use futures_lite::io::Cursor;

    use crate::base::read::stream::ZipFileReader;
    use crate::error::ZipError;

    let mut data = include_bytes!("diff-088-sample.zip").to_vec();
    data[6] |= 0x20;
    let zip = ZipFileReader::new(Cursor::new(data));

    let Err(err) = zip.next_with_entry().await else {
        panic!("expected compressed patched data in the local header to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("compressed patched data")));
}

#[tokio::test]
async fn test_seekable_reader_rejects_compressed_patched_local_headers() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let mut data = include_bytes!("diff-088-sample.zip").to_vec();
    let central_directory_offset =
        data.windows(4).position(|window| window == [0x50, 0x4b, 0x01, 0x02]).expect("central directory record");

    data[6] |= 0x20;
    data[central_directory_offset + 8] &= !0x20;
    data[central_directory_offset + 10..central_directory_offset + 12].copy_from_slice(&0u16.to_le_bytes());

    let zip = ZipFileReader::new(data).await.expect("central directory should be valid");
    let Err(err) = zip.reader_without_entry(0).await else {
        panic!("expected compressed patched data in the local header to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("compressed patched data")));
}

#[tokio::test]
async fn test_entry_body_must_not_overlap_later_local_header() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::{Compression, ZipEntryBuilder};

    let mut data = Vec::new();
    let mut writer = ZipFileWriter::new(&mut data);
    writer.write_entry_whole(ZipEntryBuilder::new("a".into(), Compression::Stored), b"").await.unwrap();
    writer.write_entry_whole(ZipEntryBuilder::new("b".into(), Compression::Stored), b"").await.unwrap();
    writer.close().await.unwrap();

    let central_directory =
        data.windows(4).position(|window| window == b"PK\x01\x02").expect("expected central directory");
    data[central_directory + 20..central_directory + 24].copy_from_slice(&1_u32.to_le_bytes());

    let zip = ZipFileReader::new(data).await.expect("central directory should be valid");
    let Err(err) = zip.reader_without_entry(0).await else {
        panic!("expected overlapping entry range");
    };
    assert!(matches!(err, ZipError::EntryDataRangeOverlap { .. }));
}

#[tokio::test]
async fn test_directory_size_must_cover_claimed_entry_count() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::{Compression, ZipEntryBuilder};

    let mut writer = ZipFileWriter::new(Vec::new());
    writer.write_entry_whole(ZipEntryBuilder::new("alpha.txt".into(), Compression::Stored), b"alpha\n").await.unwrap();
    writer.write_entry_whole(ZipEntryBuilder::new("beta.txt".into(), Compression::Stored), b"beta\n").await.unwrap();
    let mut data = writer.close().await.unwrap();

    // Clear the EOCD central-directory size while leaving the two entry counts intact.
    let eocd_offset = data.len() - 22;
    data[eocd_offset + 12..eocd_offset + 16].fill(0);

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected invalid central directory entry count");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectoryEntryCount { entries: 2 }));
}

#[tokio::test]
async fn test_directory_size_must_cover_variable_length_entries() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::{Compression, ZipEntryBuilder};

    let mut writer = ZipFileWriter::new(Vec::new());
    writer
        .write_entry_whole(ZipEntryBuilder::new("long-alpha.txt".into(), Compression::Stored), b"alpha\n")
        .await
        .unwrap();
    writer
        .write_entry_whole(ZipEntryBuilder::new("long-beta.txt".into(), Compression::Stored), b"beta\n")
        .await
        .unwrap();
    let mut data = writer.close().await.unwrap();

    // This size covers two fixed CD headers, but not their filename fields.
    let eocd_offset = data.len() - 22;
    data[eocd_offset + 12..eocd_offset + 16].copy_from_slice(&92_u32.to_le_bytes());

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected invalid central directory entry count");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectoryEntryCount { entries: 2 }));
}

#[tokio::test]
async fn test_local_extra_field_must_not_overlap_later_local_header() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::{Compression, ZipEntryBuilder};

    let mut data = Vec::new();
    let mut writer = ZipFileWriter::new(&mut data);
    writer.write_entry_whole(ZipEntryBuilder::new("a".into(), Compression::Stored), b"").await.unwrap();
    writer.write_entry_whole(ZipEntryBuilder::new("b".into(), Compression::Stored), b"").await.unwrap();
    writer.close().await.unwrap();

    // Consume the following local file header signature as a local-only extra field.
    data[28..30].copy_from_slice(&4_u16.to_le_bytes());

    let zip = ZipFileReader::new(data).await.expect("central directory should be valid");
    let Err(err) = zip.reader_without_entry(0).await else {
        panic!("expected overlapping local header range");
    };
    assert!(matches!(err, ZipError::EntryDataRangeOverlap { .. }));
}

#[tokio::test]
async fn test_many_entry_ranges_validate() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::{Compression, ZipEntryBuilder};

    let mut data = Vec::new();
    let mut writer = ZipFileWriter::new(&mut data);
    for index in 0..1_024 {
        writer
            .write_entry_whole(ZipEntryBuilder::new(format!("{index}").into(), Compression::Stored), b"")
            .await
            .unwrap();
    }
    writer.close().await.unwrap();

    let reader = ZipFileReader::new(data).await.unwrap();
    assert_eq!(reader.file().entries().len(), 1_024);
    for index in 0..1_024 {
        reader.reader_without_entry(index).await.unwrap();
    }
}

#[tokio::test]
async fn test_directory_range_must_fit_before_end_record() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let mut data = b"PK\x05\x06".to_vec();
    data.resize(22, 0);
    // A directory byte at offset zero would overlap the EOCD record there.
    data[12] = 1;

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected invalid central directory range");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectoryRange { start: 0, end: 1, boundary: 0 }));
}

#[tokio::test]
async fn test_bound_directory_span_must_be_fully_parsed() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::spec::consts::{CDH_SIGNATURE, EOCDR_SIGNATURE};
    use crate::{Compression, ZipEntryBuilder};

    let mut inner = Vec::new();
    let mut writer = ZipFileWriter::new(&mut inner);
    writer.write_entry_whole(ZipEntryBuilder::new("inner".into(), Compression::Stored), b"B").await.unwrap();
    writer.close().await.unwrap();

    let mut data = inner.clone();
    let mut writer = ZipFileWriter::new(&mut data);
    writer.write_entry_whole(ZipEntryBuilder::new("outer".into(), Compression::Stored), b"A").await.unwrap();
    writer.close().await.unwrap();

    let inner_cd = data.windows(4).position(|window| window == CDH_SIGNATURE.to_le_bytes()).unwrap();
    let selected_eocdr = data.windows(4).rposition(|window| window == EOCDR_SIGNATURE.to_le_bytes()).unwrap();
    let directory_size = (selected_eocdr - inner_cd) as u32;
    data[selected_eocdr + 12..selected_eocdr + 16].copy_from_slice(&directory_size.to_le_bytes());
    data[selected_eocdr + 16..selected_eocdr + 20].copy_from_slice(&(inner_cd as u32).to_le_bytes());

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected unparsed bytes in a bound directory span to fail");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectorySize { expected, actual } if expected > actual));
}

#[tokio::test]
async fn test_directory_allows_digital_signature_record() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::spec::consts::{CDDS_SIGNATURE, EOCDR_SIGNATURE};
    use crate::{Compression, ZipEntryBuilder};

    let mut data = Vec::new();
    let mut writer = ZipFileWriter::new(&mut data);
    writer.write_entry_whole(ZipEntryBuilder::new("signed".into(), Compression::Stored), b"A").await.unwrap();
    writer.close().await.unwrap();

    let eocdr = data.windows(4).position(|window| window == EOCDR_SIGNATURE.to_le_bytes()).unwrap();
    let signature_data = b"signature";
    let mut signature_record = CDDS_SIGNATURE.to_le_bytes().to_vec();
    signature_record.extend_from_slice(&(signature_data.len() as u16).to_le_bytes());
    signature_record.extend_from_slice(signature_data);
    let signature_record_len = signature_record.len();
    data.splice(eocdr..eocdr, signature_record);

    let eocdr = eocdr + signature_record_len;
    let directory_size = u32::from_le_bytes(data[eocdr + 12..eocdr + 16].try_into().unwrap());
    data[eocdr + 12..eocdr + 16].copy_from_slice(&(directory_size + signature_record_len as u32).to_le_bytes());

    let reader = ZipFileReader::new(data).await.unwrap();
    assert_eq!(reader.file().entries().len(), 1);
}

#[tokio::test]
async fn test_digital_signature_must_fill_declared_directory_span() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::spec::consts::{CDDS_SIGNATURE, EOCDR_SIGNATURE};
    use crate::{Compression, ZipEntryBuilder};

    let mut data = Vec::new();
    let mut writer = ZipFileWriter::new(&mut data);
    writer.write_entry_whole(ZipEntryBuilder::new("signed".into(), Compression::Stored), b"A").await.unwrap();
    writer.close().await.unwrap();

    let eocdr = data.windows(4).position(|window| window == EOCDR_SIGNATURE.to_le_bytes()).unwrap();
    let mut signature_record = CDDS_SIGNATURE.to_le_bytes().to_vec();
    signature_record.extend_from_slice(&2_u16.to_le_bytes());
    signature_record.extend_from_slice(b"x");
    let signature_record_len = signature_record.len();
    data.splice(eocdr..eocdr, signature_record);

    let eocdr = eocdr + signature_record_len;
    let directory_size = u32::from_le_bytes(data[eocdr + 12..eocdr + 16].try_into().unwrap());
    data[eocdr + 12..eocdr + 16].copy_from_slice(&(directory_size + signature_record_len as u32).to_le_bytes());

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected an incorrectly sized digital signature to fail");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectorySize { expected, actual } if actual > expected));
}

#[tokio::test]
async fn test_zip64_range_boundary_must_be_an_adjacent_end_record() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::spec::consts::{EOCDR_SIGNATURE, ZIP64_EOCDL_SIGNATURE, ZIP64_EOCDR_SIGNATURE};
    use crate::spec::header::{
        EndOfCentralDirectoryHeader, Zip64EndOfCentralDirectoryLocator, Zip64EndOfCentralDirectoryRecord,
    };
    use crate::{Compression, ZipEntryBuilder};

    let mut data = Vec::new();
    let mut writer = ZipFileWriter::new(&mut data);
    writer.write_entry_whole(ZipEntryBuilder::new("visible".into(), Compression::Stored), b"A").await.unwrap();
    writer.close().await.unwrap();

    let zip64_eocdr_offset = data.len() as u64;
    data.extend_from_slice(&ZIP64_EOCDR_SIGNATURE.to_le_bytes());
    data.extend_from_slice(
        &Zip64EndOfCentralDirectoryRecord {
            size_of_zip64_end_of_cd_record: 44,
            version_made_by: 45,
            version_needed_to_extract: 45,
            disk_number: 0,
            disk_number_start_of_cd: 0,
            num_entries_in_directory_on_disk: 0,
            num_entries_in_directory: 0,
            directory_size: 0,
            offset_of_start_of_directory: zip64_eocdr_offset,
        }
        .as_bytes(),
    );
    data.extend_from_slice(b"gap!");
    data.extend_from_slice(&ZIP64_EOCDL_SIGNATURE.to_le_bytes());
    data.extend_from_slice(
        &Zip64EndOfCentralDirectoryLocator {
            number_of_disk_with_start_of_zip64_end_of_central_directory: 0,
            relative_offset: zip64_eocdr_offset,
            total_number_of_disks: 1,
        }
        .as_bytes(),
    );
    data.extend_from_slice(&EOCDR_SIGNATURE.to_le_bytes());
    data.extend_from_slice(
        &EndOfCentralDirectoryHeader {
            disk_num: u16::MAX,
            start_cent_dir_disk: u16::MAX,
            num_of_entries_disk: u16::MAX,
            num_of_entries: u16::MAX,
            size_cent_dir: u32::MAX,
            cent_dir_offset: u32::MAX,
            file_comm_length: 0,
        }
        .as_slice(),
    );

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected non-adjacent zip64 end record to fail");
    };
    assert!(matches!(err, ZipError::InvalidZip64EndOfCentralDirectoryLocatorOffset(..)));
}

#[tokio::test]
async fn test_zip64_locator_requires_end_record_signature() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;
    use crate::spec::consts::ZIP64_EOCDR_SIGNATURE;

    let mut data = include_bytes!("../zip64/zip64.zip").to_vec();
    let offset = data
        .windows(4)
        .position(|window| window == ZIP64_EOCDR_SIGNATURE.to_le_bytes())
        .expect("expected ZIP64 EOCD record");
    data[offset..offset + 4].copy_from_slice(&0_u32.to_le_bytes());

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected invalid ZIP64 end record signature to fail");
    };
    assert!(matches!(err, ZipError::UnexpectedHeaderError(0, ZIP64_EOCDR_SIGNATURE)));
}
#[tokio::test]
async fn test_zip64_end_record_size_must_cover_fixed_fields() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;
    use crate::spec::consts::ZIP64_EOCDR_SIGNATURE;

    let mut data = include_bytes!("../zip64/zip64.zip").to_vec();
    let offset = data
        .windows(4)
        .position(|window| window == ZIP64_EOCDR_SIGNATURE.to_le_bytes())
        .expect("expected ZIP64 EOCD record");
    data[offset + 4..offset + 12].copy_from_slice(&43_u64.to_le_bytes());

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected undersized ZIP64 end record to fail");
    };
    assert!(matches!(err, ZipError::InvalidZip64EndOfCentralDirectorySize(43)));
}

#[tokio::test]
async fn test_directory_must_bind_to_selected_end_record() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::{Compression, ZipEntryBuilder};

    let mut inner = Vec::new();
    let mut writer = ZipFileWriter::new(&mut inner);
    writer.write_entry_whole(ZipEntryBuilder::new("inner".into(), Compression::Stored), b"B").await.unwrap();
    writer.close().await.unwrap();

    let mut data = inner.clone();
    let mut writer = ZipFileWriter::new(&mut data);
    writer.write_entry_whole(ZipEntryBuilder::new("outer".into(), Compression::Stored), b"A").await.unwrap();
    writer.close().await.unwrap();

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected ambiguous central directory binding to fail");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectoryBinding { .. }));
}

#[tokio::test]
async fn repro_conflicting_zip64_and_legacy_central_directories() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::spec::consts::{EOCDR_SIGNATURE, ZIP64_EOCDL_SIGNATURE, ZIP64_EOCDR_SIGNATURE};
    use crate::spec::header::{Zip64EndOfCentralDirectoryLocator, Zip64EndOfCentralDirectoryRecord};
    use crate::{Compression, ZipEntryBuilder};

    // First create an ordinary archive whose legacy EOCD describes one entry.
    let mut data = Vec::new();
    let mut writer = ZipFileWriter::new(&mut data);
    writer
        .write_entry_whole(ZipEntryBuilder::new("visible.txt".into(), Compression::Stored), b"visible")
        .await
        .unwrap();
    writer.close().await.unwrap();

    let legacy_eocdr_offset =
        data.windows(4).rposition(|window| window == EOCDR_SIGNATURE.to_le_bytes()).expect("legacy EOCD record");
    let zip64_eocdr_offset = legacy_eocdr_offset as u64;

    // Insert a valid ZIP64 end record immediately before that EOCD, but make it describe an
    // empty directory. Both the legacy and ZIP64 directory spans end at this record, so the new
    // binding check alone cannot distinguish them.
    let mut zip64_trailer = ZIP64_EOCDR_SIGNATURE.to_le_bytes().to_vec();
    zip64_trailer.extend_from_slice(
        &Zip64EndOfCentralDirectoryRecord {
            size_of_zip64_end_of_cd_record: 44,
            version_made_by: 45,
            version_needed_to_extract: 45,
            disk_number: 0,
            disk_number_start_of_cd: 0,
            num_entries_in_directory_on_disk: 0,
            num_entries_in_directory: 0,
            directory_size: 0,
            offset_of_start_of_directory: zip64_eocdr_offset,
        }
        .as_bytes(),
    );
    zip64_trailer.extend_from_slice(&ZIP64_EOCDL_SIGNATURE.to_le_bytes());
    zip64_trailer.extend_from_slice(
        &Zip64EndOfCentralDirectoryLocator {
            number_of_disk_with_start_of_zip64_end_of_central_directory: 0,
            relative_offset: zip64_eocdr_offset,
            total_number_of_disks: 1,
        }
        .as_bytes(),
    );
    data.splice(legacy_eocdr_offset..legacy_eocdr_offset, zip64_trailer);

    // A unique-directory parser must reject the disagreement instead of choosing one record's
    // view of the archive.
    let Err(err) = ZipFileReader::new(data).await else {
        panic!("conflicting ZIP64 and legacy central-directory metadata was accepted");
    };
    assert!(matches!(err, ZipError::MismatchedZip64EndOfCentralDirectoryField { .. }));
}

#[tokio::test]
async fn test_each_concrete_legacy_end_field_must_match_zip64() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;
    use crate::spec::consts::ZIP64_EOCDR_SIGNATURE;

    // Offsets are relative to the start of the ZIP64 end-record signature. Each replacement
    // differs from the concrete value in the legacy EOCD while remaining cheap to parse.
    let mismatches = [
        ("disk number", 16, 4, 1_u64),
        ("central directory start disk", 20, 4, 1),
        ("number of entries on this disk", 24, 8, 0),
        ("number of entries", 32, 8, 0),
        ("central directory size", 40, 8, 0),
        ("central directory offset", 48, 8, 0),
    ];

    for (expected_field, field_offset, field_length, value) in mismatches {
        let mut data = include_bytes!("../zip64/zip64.zip").to_vec();
        let record_offset = data
            .windows(4)
            .position(|window| window == ZIP64_EOCDR_SIGNATURE.to_le_bytes())
            .expect("ZIP64 EOCD record");
        data[record_offset + field_offset..record_offset + field_offset + field_length]
            .copy_from_slice(&value.to_le_bytes()[..field_length]);

        let Err(err) = ZipFileReader::new(data).await else {
            panic!("mismatched {expected_field} was accepted");
        };
        assert!(
            matches!(err, ZipError::MismatchedZip64EndOfCentralDirectoryField { field, .. } if field == expected_field),
            "unexpected error for {expected_field}: {err:?}"
        );
    }
}
