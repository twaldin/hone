// Copyright (c) 2025 Astral
// MIT License (https://github.com/astral-sh/rs-async-zip/blob/main/LICENSE)

#[cfg(feature = "deflate64")]
#[tokio::test]
async fn invalid_deflate64_stream_version_fails_before_body_read() {
    use crate::base::read::stream::ZipFileReader;
    use crate::error::ZipError;

    // Reduced from DIFF-071: a malformed Deflate64-looking local header before
    // an EOCD-shaped tail. Deflate64 requires version 2.1, not version 0.1.
    let data = b"PK\x03\x04\x01\x00\x00\x00\x09\x00\x00\x80\x80\x04\xfe\xba\
        \x00\x2b\xfb\x00\x06PK\x05\x06\x00\x00\x00\x04\x02\xb5P\x00\xfb\x00\
        \x06PK\x05\x06\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\
        \x00\x00\x00\x00\x00";

    let zip = ZipFileReader::new(data.as_slice());
    let Err(err) = zip.next_with_entry().await else {
        panic!("expected malformed Deflate64 entry to fail before body read");
    };

    assert!(matches!(err, ZipError::InvalidCompressionVersion { version: 1, required: 21, compression: 9 }));
}
