// Copyright (c) 2022 Harry [Majored] [hello@majored.pw]
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

use futures_lite::io::{AsyncSeek, AsyncSeekExt, AsyncWrite, AsyncWriteExt, Cursor, SeekFrom};
#[cfg(feature = "jiff")]
use jiff::{tz::Offset, Timestamp};
use std::io::{Error, ErrorKind};
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::base::write::{central_directory_size_field, ZipFileWriter};
use crate::error::{Zip64ErrorCase, ZipError};
use crate::spec::consts::{CDH_SIGNATURE, DATA_DESCRIPTOR_SIGNATURE, LFH_SIGNATURE, NON_ZIP64_MAX_SIZE};
use crate::spec::header::ExtraField;
#[cfg(feature = "jiff")]
use crate::ZipDateTime;
use crate::{Compression, ZipEntryBuilder};

pub(crate) mod offset;
#[cfg(target_pointer_width = "64")]
mod zip64;

/// /dev/null for AsyncWrite.
/// Useful for tests that involve writing, but not reading, large amounts of data.
pub(crate) struct AsyncSink;

// AsyncSink is always ready to receive bytes and throw them away.
impl AsyncWrite for AsyncSink {
    fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<Result<usize, Error>> {
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
        Poll::Ready(Ok(()))
    }
}

/// /dev/null for AsyncWrite + AsyncSeek.
#[derive(Default)]
pub(crate) struct SeekableAsyncSink {
    position: u64,
    writes: Vec<(u64, Vec<u8>)>,
}

impl SeekableAsyncSink {
    fn bytes_written_at(&self, offset: u64) -> Option<&[u8]> {
        self.writes.iter().rev().find(|(write_offset, _)| *write_offset == offset).map(|(_, bytes)| bytes.as_slice())
    }
}

impl AsyncWrite for SeekableAsyncSink {
    fn poll_write(mut self: Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<Result<usize, Error>> {
        let position = self.position;
        self.writes.push((position, buf.to_vec()));
        self.position += buf.len() as u64;
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for SeekableAsyncSink {
    fn poll_seek(mut self: Pin<&mut Self>, _: &mut Context<'_>, pos: SeekFrom) -> Poll<Result<u64, Error>> {
        let position = match pos {
            SeekFrom::Start(position) => position,
            SeekFrom::End(offset) | SeekFrom::Current(offset) => {
                let position = self.position as i128 + offset as i128;
                if position < 0 || position > u64::MAX as i128 {
                    return Poll::Ready(Err(Error::new(ErrorKind::InvalidInput, "invalid seek")));
                }
                position as u64
            }
        };
        self.position = position;
        Poll::Ready(Ok(position))
    }
}

#[cfg(not(feature = "jiff"))]
fn assert_default_modification_date(buffer: &[u8]) {
    let ((local_time, local_date), (central_time, central_date)) = modification_dates(buffer);

    assert_eq!(local_time, 0);
    assert_eq!(local_date, 0x21);
    assert_eq!(central_time, 0);
    assert_eq!(central_date, 0x21);
}

fn modification_dates(buffer: &[u8]) -> ((u16, u16), (u16, u16)) {
    let local_header_signature = LFH_SIGNATURE.to_le_bytes();
    assert_eq!(&buffer[..local_header_signature.len()], local_header_signature);
    let local_time = u16::from_le_bytes(buffer[10..12].try_into().unwrap());
    let local_date = u16::from_le_bytes(buffer[12..14].try_into().unwrap());

    let central_directory_signature = CDH_SIGNATURE.to_le_bytes();
    let central_directory_offset = buffer
        .windows(central_directory_signature.len())
        .position(|window| window == central_directory_signature)
        .unwrap();
    let central_time =
        u16::from_le_bytes(buffer[central_directory_offset + 12..central_directory_offset + 14].try_into().unwrap());
    let central_date =
        u16::from_le_bytes(buffer[central_directory_offset + 14..central_directory_offset + 16].try_into().unwrap());

    ((local_time, local_date), (central_time, central_date))
}

fn compact_entry_headers(buffer: &[u8]) -> ((u16, u16), (u16, u16)) {
    let local_header_signature = LFH_SIGNATURE.to_le_bytes();
    assert_eq!(&buffer[..local_header_signature.len()], local_header_signature);
    let local_flags = u16::from_le_bytes(buffer[6..8].try_into().unwrap());
    let local_extra_length = u16::from_le_bytes(buffer[28..30].try_into().unwrap());

    let central_directory_signature = CDH_SIGNATURE.to_le_bytes();
    let central_directory_offset = buffer
        .windows(central_directory_signature.len())
        .position(|window| window == central_directory_signature)
        .unwrap();
    let central_flags =
        u16::from_le_bytes(buffer[central_directory_offset + 8..central_directory_offset + 10].try_into().unwrap());
    let central_extra_length =
        u16::from_le_bytes(buffer[central_directory_offset + 30..central_directory_offset + 32].try_into().unwrap());

    ((local_flags, local_extra_length), (central_flags, central_extra_length))
}

fn entry_versions(buffer: &[u8]) -> (u16, u16) {
    let local_header_signature = LFH_SIGNATURE.to_le_bytes();
    assert_eq!(&buffer[..local_header_signature.len()], local_header_signature);
    let local_version = u16::from_le_bytes(buffer[4..6].try_into().unwrap());

    let central_directory_signature = CDH_SIGNATURE.to_le_bytes();
    let central_directory_offset = buffer
        .windows(central_directory_signature.len())
        .position(|window| window == central_directory_signature)
        .unwrap();
    let central_version =
        u16::from_le_bytes(buffer[central_directory_offset + 6..central_directory_offset + 8].try_into().unwrap());

    (local_version, central_version)
}

#[cfg(feature = "jiff")]
fn assert_current_modification_date(buffer: &[u8]) {
    let ((local_time, local_date), (central_time, central_date)) = modification_dates(buffer);
    assert_eq!((local_time, local_date), (central_time, central_date));

    let date = ZipDateTime { date: local_date, time: local_time };
    let now = Offset::UTC.to_datetime(Timestamp::now());

    assert_eq!(i32::from(now.year()), date.year());
    assert_ne!(ZipDateTime::default(), date);
}

#[cfg(not(feature = "jiff"))]
#[tokio::test]
async fn default_modification_date_is_valid_for_whole_writes() {
    let mut buffer = Vec::new();
    let mut writer = ZipFileWriter::new(&mut buffer);
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored);

    writer.write_entry_whole(entry, b"data").await.unwrap();
    writer.close().await.unwrap();

    assert_default_modification_date(&buffer);
}

#[cfg(not(feature = "jiff"))]
#[tokio::test]
async fn default_modification_date_is_valid_for_stream_writes() {
    let mut buffer = Vec::new();
    let mut writer = ZipFileWriter::new(&mut buffer);
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored);

    let mut entry_writer = writer.write_entry_stream(entry).await.unwrap();
    entry_writer.write_all(b"data").await.unwrap();
    entry_writer.close().await.unwrap();
    writer.close().await.unwrap();

    assert_default_modification_date(&buffer);
}

#[cfg(not(feature = "jiff"))]
#[tokio::test]
async fn default_modification_date_is_valid_for_seekable_stream_writes() {
    let mut writer = ZipFileWriter::new(Cursor::new(Vec::new()));
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored);

    let mut entry_writer = writer.write_entry_seekable(entry).await.unwrap();
    entry_writer.write_all(b"data").await.unwrap();
    entry_writer.close().await.unwrap();
    let buffer = writer.close().await.unwrap().into_inner();

    assert_default_modification_date(&buffer);
}

#[cfg(feature = "jiff")]
#[tokio::test]
async fn default_modification_date_uses_current_time_for_whole_writes() {
    let mut buffer = Vec::new();
    let mut writer = ZipFileWriter::new(&mut buffer);
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored);

    writer.write_entry_whole(entry, b"data").await.unwrap();
    writer.close().await.unwrap();

    assert_current_modification_date(&buffer);
}

#[cfg(feature = "jiff")]
#[tokio::test]
async fn default_modification_date_uses_current_time_for_stream_writes() {
    let mut buffer = Vec::new();
    let mut writer = ZipFileWriter::new(&mut buffer);
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored);

    let mut entry_writer = writer.write_entry_stream(entry).await.unwrap();
    entry_writer.write_all(b"data").await.unwrap();
    entry_writer.close().await.unwrap();
    writer.close().await.unwrap();

    assert_current_modification_date(&buffer);
}

#[cfg(feature = "jiff")]
#[tokio::test]
async fn default_modification_date_uses_current_time_for_seekable_stream_writes() {
    let mut writer = ZipFileWriter::new(Cursor::new(Vec::new()));
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored);

    let mut entry_writer = writer.write_entry_seekable(entry).await.unwrap();
    entry_writer.write_all(b"data").await.unwrap();
    entry_writer.close().await.unwrap();
    let buffer = writer.close().await.unwrap().into_inner();

    assert_current_modification_date(&buffer);
}

#[tokio::test]
async fn seekable_stream_writes_compact_headers() {
    let mut writer = ZipFileWriter::new(Cursor::new(Vec::new()));
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored);

    let mut entry_writer = writer.write_entry_seekable(entry).await.unwrap();
    entry_writer.write_all(b"data").await.unwrap();
    entry_writer.close().await.unwrap();
    let buffer = writer.close().await.unwrap().into_inner();

    let ((local_flags, local_extra_length), (central_flags, central_extra_length)) = compact_entry_headers(&buffer);
    assert_eq!(local_flags & (1 << 3), 0);
    assert_eq!(central_flags & (1 << 3), 0);
    assert_eq!(local_extra_length, 0);
    assert_eq!(central_extra_length, 0);

    let data_descriptor_signature = DATA_DESCRIPTOR_SIGNATURE.to_le_bytes();
    assert!(!buffer.windows(data_descriptor_signature.len()).any(|window| window == data_descriptor_signature));

    let cursor = std::io::Cursor::new(buffer);
    let mut zip = zip::read::ZipArchive::new(cursor).unwrap();
    let mut file = zip.by_name("file").unwrap();
    let mut contents = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut contents).unwrap();
    assert_eq!(contents, b"data");
}

#[tokio::test]
async fn seekable_stream_updates_reserved_zip64_sizes_when_actual_size_fits() {
    let data = b"data";
    let mut writer = ZipFileWriter::new(Cursor::new(Vec::new()));
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored)
        .size(NON_ZIP64_MAX_SIZE as u64 + 1, NON_ZIP64_MAX_SIZE as u64 + 1);

    let mut entry_writer = writer.write_entry_seekable(entry).await.unwrap();
    entry_writer.write_all(data).await.unwrap();
    entry_writer.close().await.unwrap();

    assert!(writer.is_zip64);
    let cd_entry = writer.cd_entries.last().unwrap();
    assert_eq!(cd_entry.header.compressed_size, NON_ZIP64_MAX_SIZE);
    assert_eq!(cd_entry.header.uncompressed_size, NON_ZIP64_MAX_SIZE);
    match cd_entry.entry.extra_fields().last().unwrap() {
        ExtraField::Zip64ExtendedInformation(zip64) => {
            assert_eq!(zip64.compressed_size, Some(data.len() as u64));
            assert_eq!(zip64.uncompressed_size, Some(data.len() as u64));
        }
        field => panic!("Expected a Zip64 extended field, got {field:?}"),
    }

    let buffer = writer.close().await.unwrap().into_inner();
    let (local_version, central_version) = entry_versions(&buffer);
    assert_eq!(local_version, 45);
    assert_eq!(central_version, 45);
    assert_eq!(u32::from_le_bytes(buffer[18..22].try_into().unwrap()), NON_ZIP64_MAX_SIZE);
    assert_eq!(u32::from_le_bytes(buffer[22..26].try_into().unwrap()), NON_ZIP64_MAX_SIZE);

    let central_directory_offset = buffer
        .windows(CDH_SIGNATURE.to_le_bytes().len())
        .position(|window| window == CDH_SIGNATURE.to_le_bytes())
        .unwrap();
    assert_eq!(
        u32::from_le_bytes(buffer[central_directory_offset + 20..central_directory_offset + 24].try_into().unwrap()),
        NON_ZIP64_MAX_SIZE,
    );
    assert_eq!(
        u32::from_le_bytes(buffer[central_directory_offset + 24..central_directory_offset + 28].try_into().unwrap()),
        NON_ZIP64_MAX_SIZE,
    );

    let reader = crate::base::read::mem::ZipFileReader::new(buffer).await.unwrap();
    assert!(reader.file().zip64);
    assert_eq!(reader.file().entries[0].entry.compressed_size, data.len() as u64);
    assert_eq!(reader.file().entries[0].entry.uncompressed_size, data.len() as u64);
}

#[tokio::test]
async fn seekable_stream_reserves_zip64_sizes_at_legacy_sentinel() {
    let data = b"data";
    let mut writer = ZipFileWriter::new(Cursor::new(Vec::new()));
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored)
        .size(NON_ZIP64_MAX_SIZE as u64, NON_ZIP64_MAX_SIZE as u64);

    let mut entry_writer = writer.write_entry_seekable(entry).await.unwrap();
    entry_writer.write_all(data).await.unwrap();
    entry_writer.close().await.unwrap();

    assert!(writer.is_zip64);
    let cd_entry = writer.cd_entries.last().unwrap();
    assert_eq!(cd_entry.header.compressed_size, NON_ZIP64_MAX_SIZE);
    assert_eq!(cd_entry.header.uncompressed_size, NON_ZIP64_MAX_SIZE);
    match cd_entry.entry.extra_fields().last().unwrap() {
        ExtraField::Zip64ExtendedInformation(zip64) => {
            assert_eq!(zip64.compressed_size, Some(data.len() as u64));
            assert_eq!(zip64.uncompressed_size, Some(data.len() as u64));
        }
        field => panic!("Expected a Zip64 extended field, got {field:?}"),
    }
}

#[tokio::test]
async fn seekable_stream_preserves_data_with_existing_zip64_extra_field() {
    let data = b"data";
    let mut writer = ZipFileWriter::new(Cursor::new(Vec::new()));
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored)
        .size(NON_ZIP64_MAX_SIZE as u64 + 1, NON_ZIP64_MAX_SIZE as u64 + 1)
        .extra_fields(vec![ExtraField::Zip64ExtendedInformation(
            crate::spec::header::Zip64ExtendedInformationExtraField {
                uncompressed_size: None,
                compressed_size: None,
                relative_header_offset: None,
                disk_start_number: None,
            },
        )]);

    let mut entry_writer = writer.write_entry_seekable(entry).await.unwrap();
    entry_writer.write_all(data).await.unwrap();
    entry_writer.close().await.unwrap();
    let buffer = writer.close().await.unwrap().into_inner();

    let cursor = std::io::Cursor::new(buffer);
    let mut zip = zip::read::ZipArchive::new(cursor).unwrap();
    let mut file = zip.by_name("file").unwrap();
    let mut contents = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut contents).unwrap();
    assert_eq!(contents, data);
}

#[tokio::test]
async fn seekable_stream_raises_version_needed_for_zip64_local_header_offset() {
    let mut writer = ZipFileWriter::new(SeekableAsyncSink::default());
    writer.writer.seek(SeekFrom::Start(NON_ZIP64_MAX_SIZE as u64 + 1)).await.unwrap();
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored);

    let mut entry_writer = writer.write_entry_seekable(entry).await.unwrap();
    entry_writer.write_all(b"data").await.unwrap();
    entry_writer.close().await.unwrap();

    assert!(writer.is_zip64);
    let local_header = writer
        .writer
        .inner_mut()
        .bytes_written_at(NON_ZIP64_MAX_SIZE as u64 + 1 + LFH_SIGNATURE.to_le_bytes().len() as u64)
        .unwrap();
    assert_eq!(u16::from_le_bytes(local_header[0..2].try_into().unwrap()), 45);
    let cd_entry = writer.cd_entries.last().unwrap();
    assert_eq!(cd_entry.header.v_needed, 45);
    assert_eq!(cd_entry.header.lh_offset, NON_ZIP64_MAX_SIZE);
    match cd_entry.entry.extra_fields().last().unwrap() {
        ExtraField::Zip64ExtendedInformation(zip64) => {
            assert_eq!(zip64.compressed_size, None);
            assert_eq!(zip64.uncompressed_size, None);
            assert_eq!(zip64.relative_header_offset, Some(NON_ZIP64_MAX_SIZE as u64 + 1));
        }
        field => panic!("Expected a Zip64 extended field, got {field:?}"),
    }

    writer.close().await.unwrap();
}

#[tokio::test]
async fn seekable_stream_raises_version_needed_at_zip64_local_header_offset_sentinel() {
    let mut writer = ZipFileWriter::new(SeekableAsyncSink::default());
    writer.writer.seek(SeekFrom::Start(NON_ZIP64_MAX_SIZE as u64)).await.unwrap();
    let entry = ZipEntryBuilder::new("file".into(), Compression::Stored);

    let mut entry_writer = writer.write_entry_seekable(entry).await.unwrap();
    entry_writer.write_all(b"data").await.unwrap();
    entry_writer.close().await.unwrap();

    assert!(writer.is_zip64);
    let local_header = writer
        .writer
        .inner_mut()
        .bytes_written_at(NON_ZIP64_MAX_SIZE as u64 + LFH_SIGNATURE.to_le_bytes().len() as u64)
        .unwrap();
    assert_eq!(u16::from_le_bytes(local_header[0..2].try_into().unwrap()), 45);
    let cd_entry = writer.cd_entries.last().unwrap();
    assert_eq!(cd_entry.header.v_needed, 45);
    assert_eq!(cd_entry.header.lh_offset, NON_ZIP64_MAX_SIZE);
    match cd_entry.entry.extra_fields().last().unwrap() {
        ExtraField::Zip64ExtendedInformation(zip64) => {
            assert_eq!(zip64.compressed_size, None);
            assert_eq!(zip64.uncompressed_size, None);
            assert_eq!(zip64.relative_header_offset, Some(NON_ZIP64_MAX_SIZE as u64));
        }
        field => panic!("Expected a Zip64 extended field, got {field:?}"),
    }

    writer.close().await.unwrap();
}

#[cfg(feature = "deflate")]
#[tokio::test]
async fn seekable_stream_deflate_writes_compact_headers() {
    let contents = b"repeated data ".repeat(128);
    let mut writer = ZipFileWriter::new(Cursor::new(Vec::new()));
    let entry = ZipEntryBuilder::new("file".into(), Compression::Deflate);

    let mut entry_writer = writer.write_entry_seekable(entry).await.unwrap();
    entry_writer.write_all(&contents).await.unwrap();
    entry_writer.close().await.unwrap();
    let buffer = writer.close().await.unwrap().into_inner();

    let ((local_flags, local_extra_length), (central_flags, central_extra_length)) = compact_entry_headers(&buffer);
    assert_eq!(local_flags & (1 << 3), 0);
    assert_eq!(central_flags & (1 << 3), 0);
    assert_eq!(local_extra_length, 0);
    assert_eq!(central_extra_length, 0);

    let reader = crate::base::read::mem::ZipFileReader::new(buffer).await.unwrap();
    let mut entry = reader.reader_without_entry(0).await.unwrap();
    let mut actual = Vec::new();
    futures_lite::io::AsyncReadExt::read_to_end(&mut entry, &mut actual).await.unwrap();
    assert_eq!(actual, contents);
}

#[tokio::test]
async fn reject_large_archive_comment() {
    let mut buffer = Vec::new();
    let mut writer = ZipFileWriter::new(&mut buffer);
    writer.comment("x".repeat(u16::MAX as usize + 1));

    let result = writer.close().await;

    assert!(matches!(result, Err(ZipError::CommentTooLarge)));
    assert!(buffer.is_empty());
}

#[cfg(feature = "deflate64")]
#[tokio::test]
async fn reject_deflate64_whole_writes() {
    let mut buffer = Vec::new();
    let mut writer = ZipFileWriter::new(&mut buffer);
    let entry = ZipEntryBuilder::new("file".into(), Compression::Deflate64);

    let result = writer.write_entry_whole(entry, b"data").await;

    assert!(matches!(result, Err(ZipError::FeatureNotSupported("Deflate64 writing"))));
    assert!(buffer.is_empty());
}

#[cfg(feature = "deflate64")]
#[tokio::test]
async fn reject_deflate64_stream_writes() {
    let mut buffer = Vec::new();
    let mut writer = ZipFileWriter::new(&mut buffer);
    let entry = ZipEntryBuilder::new("file".into(), Compression::Deflate64);

    let result = writer.write_entry_stream(entry).await;

    assert!(matches!(result, Err(ZipError::FeatureNotSupported("Deflate64 writing"))));
    assert!(buffer.is_empty());
}

#[cfg(feature = "deflate64")]
#[tokio::test]
async fn reject_deflate64_seekable_stream_writes() {
    let mut writer = ZipFileWriter::new(Cursor::new(Vec::new()));
    let entry = ZipEntryBuilder::new("file".into(), Compression::Deflate64);

    let result = writer.write_entry_seekable(entry).await;

    assert!(matches!(result, Err(ZipError::FeatureNotSupported("Deflate64 writing"))));
}

#[test]
fn large_central_directory_size_uses_zip64() {
    let mut is_zip64 = false;

    let field = central_directory_size_field(NON_ZIP64_MAX_SIZE as u64 + 1, false, &mut is_zip64).unwrap();

    assert_eq!(field, NON_ZIP64_MAX_SIZE);
    assert!(is_zip64);
}

#[test]
fn large_central_directory_size_errors_without_zip64() {
    let mut is_zip64 = false;

    let result = central_directory_size_field(NON_ZIP64_MAX_SIZE as u64 + 1, true, &mut is_zip64);

    assert!(matches!(result, Err(ZipError::Zip64Needed(Zip64ErrorCase::LargeFile))));
    assert!(!is_zip64);
}
