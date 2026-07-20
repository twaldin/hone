// Copyright (c) 2023 Harry [Majored] [hello@majored.pw]
// Copyright (c) 2023 Cognite AS
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

use futures_lite::io::AsyncReadExt;

use crate::spec::consts::{CDH_SIGNATURE, LFH_SIGNATURE};
use crate::tests::init_logger;

const ZIP64_ZIP_CONTENTS: &str = "Hello World!\n";

fn retag_zip64_extra_field(mut data: Vec<u8>, signature: u32) -> Vec<u8> {
    let signature_offset =
        data.windows(4).position(|bytes| bytes == signature.to_le_bytes()).expect("header signature");
    let (header_size, filename_length_offset) = match signature {
        LFH_SIGNATURE => (30, 26),
        CDH_SIGNATURE => (46, 28),
        _ => panic!("unsupported header signature"),
    };
    let filename_length = u16::from_le_bytes(
        data[signature_offset + filename_length_offset..signature_offset + filename_length_offset + 2]
            .try_into()
            .unwrap(),
    ) as usize;
    let extra_field_offset = signature_offset + header_size + filename_length;
    assert_eq!(&data[extra_field_offset..extra_field_offset + 2], &1_u16.to_le_bytes());
    data[extra_field_offset..extra_field_offset + 2].copy_from_slice(&0xf00d_u16.to_le_bytes());
    data
}

/// Tests opening and reading a zip64 archive.
/// It contains one file named "-" with a zip 64 extended field header.
#[tokio::test]
async fn test_read_zip64_archive_mem() {
    use crate::base::read::mem::ZipFileReader;
    init_logger();

    let data = include_bytes!("zip64.zip").to_vec();

    let reader = ZipFileReader::new(data).await.unwrap();
    let mut entry_reader = reader.reader_without_entry(0).await.unwrap();

    let mut read_data = String::new();
    entry_reader.read_to_string(&mut read_data).await.expect("read failed");

    assert_eq!(
        read_data.chars().count(),
        ZIP64_ZIP_CONTENTS.chars().count(),
        "{read_data:?} != {ZIP64_ZIP_CONTENTS:?}"
    );
    assert_eq!(read_data, ZIP64_ZIP_CONTENTS);
}

/// Like test_read_zip64_archive_mem() but for the streaming version
#[tokio::test]
async fn test_read_zip64_archive_stream() {
    use crate::base::read::stream::ZipFileReader;
    init_logger();

    let data = include_bytes!("zip64.zip").to_vec();

    let reader = ZipFileReader::new(data.as_slice());
    let mut entry_reader = reader.next_without_entry().await.unwrap().unwrap();

    let mut read_data = String::new();
    entry_reader.reader_mut().read_to_string(&mut read_data).await.expect("read failed");

    assert_eq!(
        read_data.chars().count(),
        ZIP64_ZIP_CONTENTS.chars().count(),
        "{read_data:?} != {ZIP64_ZIP_CONTENTS:?}"
    );
    assert_eq!(read_data, ZIP64_ZIP_CONTENTS);
}

#[tokio::test]
async fn test_zip64_entry_count_must_fit_before_zip64_eocdr() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;
    use crate::spec::consts::{EOCDR_SIGNATURE, ZIP64_EOCDL_SIGNATURE, ZIP64_EOCDR_SIGNATURE};
    use crate::spec::header::Zip64EndOfCentralDirectoryRecord;

    let mut data = Vec::new();
    data.extend_from_slice(&ZIP64_EOCDR_SIGNATURE.to_le_bytes());
    data.extend_from_slice(
        &Zip64EndOfCentralDirectoryRecord {
            size_of_zip64_end_of_cd_record: 44,
            version_made_by: 45,
            version_needed_to_extract: 45,
            disk_number: 0,
            disk_number_start_of_cd: 0,
            num_entries_in_directory_on_disk: u64::MAX,
            num_entries_in_directory: u64::MAX,
            directory_size: 0,
            offset_of_start_of_directory: 0,
        }
        .as_bytes(),
    );
    data.extend_from_slice(&ZIP64_EOCDL_SIGNATURE.to_le_bytes());
    data.extend_from_slice(&0_u32.to_le_bytes());
    data.extend_from_slice(&0_u64.to_le_bytes());
    data.extend_from_slice(&1_u32.to_le_bytes());
    data.extend_from_slice(&EOCDR_SIGNATURE.to_le_bytes());
    data.extend_from_slice(&0_u16.to_le_bytes());
    data.extend_from_slice(&0_u16.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&u32::MAX.to_le_bytes());
    data.extend_from_slice(&u32::MAX.to_le_bytes());
    data.extend_from_slice(&0_u16.to_le_bytes());

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected invalid central directory entry count");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectoryEntryCount { entries: u64::MAX }));
}

#[tokio::test]
async fn test_zip64_sentinel_requires_matching_extra_value() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let data = include_bytes!("diff-002-sample.zip").to_vec();

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected incomplete ZIP64 extended field");
    };
    assert!(matches!(err, ZipError::Zip64ExtendedFieldIncomplete));
}

#[tokio::test]
async fn test_zip64_central_sentinel_requires_recognized_extra_field() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let data = retag_zip64_extra_field(include_bytes!("diff-002-sample.zip").to_vec(), CDH_SIGNATURE);

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected missing ZIP64 extended field");
    };
    assert!(matches!(err, ZipError::Zip64ExtendedFieldIncomplete));
}

#[tokio::test]
async fn test_zip64_local_sentinel_requires_recognized_extra_field() {
    use crate::base::read::stream::ZipFileReader;
    use crate::error::ZipError;

    let data = retag_zip64_extra_field(include_bytes!("zip64.zip").to_vec(), LFH_SIGNATURE);
    let reader = ZipFileReader::new(data.as_slice());

    let Err(err) = reader.next_without_entry().await else {
        panic!("expected missing ZIP64 extended field");
    };
    assert!(matches!(err, ZipError::Zip64ExtendedFieldIncomplete));
}

#[tokio::test]
async fn test_zip64_seekable_local_sentinel_requires_recognized_extra_field() {
    use crate::base::read::mem::ZipFileReader;
    use crate::error::ZipError;

    let data = retag_zip64_extra_field(include_bytes!("zip64.zip").to_vec(), LFH_SIGNATURE);
    let reader = ZipFileReader::new(data).await.unwrap();

    let Err(err) = reader.reader_without_entry(0).await else {
        panic!("expected missing ZIP64 extended field");
    };
    assert!(matches!(err, ZipError::Zip64ExtendedFieldIncomplete));
}

#[tokio::test]
async fn test_zip64_directory_size_must_cover_variable_length_entries() {
    use crate::base::read::mem::ZipFileReader;
    use crate::base::write::ZipFileWriter;
    use crate::error::ZipError;
    use crate::spec::consts::ZIP64_EOCDR_SIGNATURE;
    use crate::{Compression, ZipEntryBuilder};

    let mut writer = ZipFileWriter::new(Vec::new()).force_zip64();
    writer
        .write_entry_whole(ZipEntryBuilder::new("long-alpha.txt".into(), Compression::Stored), b"alpha\n")
        .await
        .unwrap();
    writer
        .write_entry_whole(ZipEntryBuilder::new("long-beta.txt".into(), Compression::Stored), b"beta\n")
        .await
        .unwrap();
    let mut data = writer.close().await.unwrap();

    let zip64_eocd_offset = data
        .windows(ZIP64_EOCDR_SIGNATURE.to_le_bytes().len())
        .position(|window| window == ZIP64_EOCDR_SIGNATURE.to_le_bytes())
        .unwrap();
    // Select the ZIP64 directory-size field and make it cover only fixed CD headers.
    data[zip64_eocd_offset + 40..zip64_eocd_offset + 48].copy_from_slice(&92_u64.to_le_bytes());
    let eocd_offset = data.len() - 22;
    data[eocd_offset + 12..eocd_offset + 16].copy_from_slice(&u32::MAX.to_le_bytes());

    let Err(err) = ZipFileReader::new(data).await else {
        panic!("expected invalid central directory entry count");
    };
    assert!(matches!(err, ZipError::InvalidCentralDirectoryEntryCount { entries: 2 }));
}

/// Generate an example file only if it doesn't exist already.
/// The file is placed adjacent to this rs file.
#[cfg(feature = "tokio")]
fn generate_zip64many_zip() -> std::path::PathBuf {
    use std::io::Write;
    use zip::write::{ExtendedFileOptions, FileOptions};

    let mut path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("src/tests/read/zip64/zip64many.zip");

    // Only recreate the zip if it doesnt already exist.
    if path.exists() {
        return path;
    }

    let zip_file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(zip_file);
    let options: FileOptions<'_, ExtendedFileOptions> =
        FileOptions::default().compression_method(zip::CompressionMethod::Stored);

    for i in 0..2_u32.pow(16) + 1 {
        zip.start_file(format!("{i}.txt"), options.clone()).unwrap();
        zip.write_all(b"\n").unwrap();
    }

    zip.finish().unwrap();

    path
}

/// Test reading a generated zip64 archive that contains more than 2^16 entries.
#[cfg(feature = "tokio-fs")]
#[tokio::test]
async fn test_read_zip64_archive_many_entries() {
    use crate::tokio::read::fs::ZipFileReader;

    init_logger();

    let path = generate_zip64many_zip();

    let reader = ZipFileReader::new(path).await.unwrap();

    // Verify that each entry exists and is has the contents "\n"
    for i in 0..2_u32.pow(16) + 1 {
        let entry = reader.file().entries().get(i as usize).unwrap();
        eprintln!("{:?}", entry.filename().as_bytes());
        assert_eq!(entry.filename.as_str().unwrap(), format!("{i}.txt"));
        let mut entry = reader.reader_without_entry(i as usize).await.unwrap();
        let mut contents = String::new();
        entry.read_to_string(&mut contents).await.unwrap();
        assert_eq!(contents, "\n");
    }
}
