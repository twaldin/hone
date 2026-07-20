// Copyright (c) 2025 Astral
// MIT License (https://github.com/astral-sh/rs-async-zip/blob/main/LICENSE)

#[cfg(feature = "deflate64")]
fn deflate64_zip(local_version: u16, central_version: u16) -> Vec<u8> {
    use crate::spec::consts::{CDH_SIGNATURE, EOCDR_SIGNATURE, LFH_SIGNATURE};
    use crate::spec::header::{
        CentralDirectoryRecord, EndOfCentralDirectoryHeader, GeneralPurposeFlag, LocalFileHeader,
    };

    let filename = b"a";
    let flags = GeneralPurposeFlag {
        encrypted: false,
        strong_encryption: false,
        compressed_patched: false,
        data_descriptor: false,
        filename_unicode: false,
    };

    let mut data = Vec::new();
    data.extend_from_slice(&LFH_SIGNATURE.to_le_bytes());
    data.extend_from_slice(
        &LocalFileHeader {
            version: local_version,
            flags,
            compression: 9,
            mod_time: 0,
            mod_date: 0,
            crc: 0,
            compressed_size: 0,
            uncompressed_size: 0,
            file_name_length: filename.len() as u16,
            extra_field_length: 0,
        }
        .as_slice(),
    );
    data.extend_from_slice(filename);

    let central_directory_offset = data.len() as u32;
    data.extend_from_slice(&CDH_SIGNATURE.to_le_bytes());
    data.extend_from_slice(
        &CentralDirectoryRecord {
            v_made_by: central_version,
            v_needed: central_version,
            flags,
            compression: 9,
            mod_time: 0,
            mod_date: 0,
            crc: 0,
            compressed_size: 0,
            uncompressed_size: 0,
            file_name_length: filename.len() as u16,
            extra_field_length: 0,
            file_comment_length: 0,
            disk_start: 0,
            inter_attr: 0,
            exter_attr: 0,
            lh_offset: 0,
        }
        .as_slice(),
    );
    data.extend_from_slice(filename);

    let central_directory_size = data.len() as u32 - central_directory_offset;
    data.extend_from_slice(&EOCDR_SIGNATURE.to_le_bytes());
    data.extend_from_slice(
        &EndOfCentralDirectoryHeader {
            disk_num: 0,
            start_cent_dir_disk: 0,
            num_of_entries_disk: 1,
            num_of_entries: 1,
            size_cent_dir: central_directory_size,
            cent_dir_offset: central_directory_offset,
            file_comm_length: 0,
        }
        .as_slice(),
    );

    data
}

#[cfg(feature = "deflate64")]
#[tokio::test]
async fn invalid_central_directory_version_is_rejected() {
    use futures_lite::io::{BufReader, Cursor};

    use crate::base::read::seek::ZipFileReader;
    use crate::error::ZipError;

    let data = deflate64_zip(21, 1);
    let Err(err) = ZipFileReader::new(BufReader::new(Cursor::new(data))).await else {
        panic!("expected the central directory version to be rejected");
    };

    assert!(matches!(err, ZipError::InvalidCompressionVersion { version: 1, required: 21, compression: 9 }));
}

#[cfg(feature = "deflate64")]
#[tokio::test]
async fn invalid_seekable_local_header_version_is_rejected_before_entry_read() {
    use futures_lite::io::{BufReader, Cursor};

    use crate::base::read::seek::ZipFileReader;
    use crate::error::ZipError;

    let data = deflate64_zip(1, 21);
    let mut zip = ZipFileReader::new(BufReader::new(Cursor::new(data))).await.unwrap();
    let Err(err) = zip.reader_without_entry(0).await else {
        panic!("expected the local header version to be rejected before entry read");
    };

    assert!(matches!(err, ZipError::InvalidCompressionVersion { version: 1, required: 21, compression: 9 }));
}
