// Copyright (c) 2025 Astral
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

use crate::error::ZipError;

fn locally_encrypted_archive() -> Vec<u8> {
    let mut data = include_bytes!("cd/diff-085-sample.zip").to_vec();
    let central_directory = data
        .windows(4)
        .position(|window| window == [0x50, 0x4b, 0x01, 0x02])
        .expect("fixture should contain a central directory record");

    // Keep the fixture usable without optional compression features: neither test
    // reads the entry body, so Stored is sufficient to exercise header parsing.
    data[8..10].copy_from_slice(&0u16.to_le_bytes());
    data[central_directory + 10..central_directory + 12].copy_from_slice(&0u16.to_le_bytes());
    data[6] |= 1;
    data[central_directory + 8] &= !1;
    data
}

#[tokio::test]
async fn test_streaming_reader_rejects_local_header_encryption() {
    use crate::base::read::stream::ZipFileReader;

    let data = locally_encrypted_archive();
    let reader = ZipFileReader::new(data.as_slice());

    let Err(err) = reader.next_without_entry().await else {
        panic!("expected local-header encryption to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("encryption")));
}

#[tokio::test]
async fn test_seekable_reader_rejects_local_header_encryption() {
    use crate::base::read::mem::ZipFileReader;

    let data = locally_encrypted_archive();
    let reader = ZipFileReader::new(data).await.unwrap();

    let Err(err) = reader.reader_without_entry(0).await else {
        panic!("expected local-header encryption to be rejected");
    };
    assert!(matches!(err, ZipError::FeatureNotSupported("encryption")));
}
