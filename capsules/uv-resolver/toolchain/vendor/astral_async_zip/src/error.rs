// Copyright (c) 2021 Harry [Majored] [hello@majored.pw]
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

//! A module which holds relevant error reporting structures/types.

use std::fmt::{Display, Formatter};
use thiserror::Error;

/// A Result type alias over ZipError to minimise repetition.
pub type Result<V> = std::result::Result<V, ZipError>;

#[derive(Debug, PartialEq, Eq)]
pub enum Zip64ErrorCase {
    TooManyFiles,
    LargeFile,
}

impl Display for Zip64ErrorCase {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooManyFiles => write!(f, "More than 65536 files in archive"),
            Self::LargeFile => write!(f, "File is larger than 4 GiB"),
        }
    }
}

/// An enum of possible errors and their descriptions.
#[non_exhaustive]
#[derive(Debug, Error)]
pub enum ZipError {
    #[error("feature not supported: '{0}'")]
    FeatureNotSupported(&'static str),
    #[error("compression not supported: {0}")]
    CompressionNotSupported(u16),
    #[error("host attribute compatibility not supported: {0}")]
    AttributeCompatibilityNotSupported(u16),
    #[error("attempted to read a ZIP64 file whilst on a 32-bit target")]
    TargetZip64NotSupported,
    #[error("attempted to write a ZIP file with force_no_zip64 when ZIP64 is needed: {0}")]
    Zip64Needed(Zip64ErrorCase),
    #[error("end of file has not been reached")]
    EOFNotReached,
    #[error("extra fields exceeded maximum size")]
    ExtraFieldTooLarge,
    #[error("comment exceeded maximum size")]
    CommentTooLarge,
    #[error("filename exceeded maximum size")]
    FileNameTooLarge,
    #[error("filename contained an embedded NUL byte")]
    FileNameContainsNul { filename: Vec<u8> },
    #[error("attempted to convert non-UTF8 bytes to a string/str")]
    StringNotUtf8,

    #[error("unable to locate the end of central directory record")]
    UnableToLocateEOCDR,
    #[error("extra field size was indicated to be {0} but fewer than {0} bytes remain")]
    InvalidExtraFieldHeader(u16),
    #[error("zip64 extended information field was incomplete")]
    Zip64ExtendedFieldIncomplete,
    #[error("an extra field with id {0:#x} was duplicated in the header")]
    DuplicateExtraFieldHeader(u16),

    #[error("an upstream reader returned an error: {0}")]
    UpstreamReadError(#[from] std::io::Error),
    #[error("a computed CRC32 value did not match the expected value")]
    CRC32CheckError,
    #[error("entry index was out of bounds")]
    EntryIndexOutOfBounds,
    #[error("the local file header name did not match the central directory name")]
    LocalFileHeaderNameMismatch,
    #[error("local file header data-descriptor flag did not match the central directory flag")]
    LocalFileHeaderDataDescriptorMismatch,
    #[error("local file header sizes did not match the central directory sizes")]
    LocalFileHeaderSizeMismatch,
    #[error("entry data range was invalid")]
    InvalidEntryDataRange,
    #[error("entry data range ({start:#x}..{end:#x}) overlapped ZIP structure at {boundary:#x}")]
    EntryDataRangeOverlap { start: u64, end: u64, boundary: u64 },
    #[error("ZIP version {version} is too low for compression method {compression}; expected {required}")]
    InvalidCompressionVersion { version: u16, required: u16, compression: u16 },
    #[error("Encountered an unexpected header (actual: {0:#x}, expected: {1:#x}).")]
    UnexpectedHeaderError(u32, u32),

    #[error("Info-ZIP Unicode Comment Extra Field was incomplete")]
    InfoZipUnicodeCommentFieldIncomplete,
    #[error("Info-ZIP Unicode Path Extra Field was incomplete")]
    InfoZipUnicodePathFieldIncomplete,
    #[error("Info-ZIP Unicode Path Extra Field contains invalid UTF-8")]
    InfoZipUnicodePathFieldInvalidUtf8,

    #[error("the end of central directory offset ({0:#x}) did not match the actual offset ({1:#x})")]
    InvalidEndOfCentralDirectoryOffset(u64, u64),
    #[error("the central directory size ({expected:#x}) did not match the observed byte span ({actual:#x})")]
    InvalidCentralDirectorySize { expected: u64, actual: u64 },
    #[error("the central directory range ({start:#x}..{end:#x}) extends past the end record offset ({boundary:#x})")]
    InvalidCentralDirectoryRange { start: u64, end: u64, boundary: u64 },
    #[error("the central directory end ({directory_end:#x}) did not bind to the end record at {end_record:#x}")]
    InvalidCentralDirectoryBinding { directory_end: u64, end_record: u64 },
    #[error("the central directory entry count ({entries}) exceeds the available central directory range")]
    InvalidCentralDirectoryEntryCount { entries: u64 },
    #[error("the zip64 end of central directory locator was not found")]
    MissingZip64EndOfCentralDirectoryLocator,
    #[error("the zip64 end of central directory locator offset ({0:#x}) did not match the actual offset ({1:#x})")]
    InvalidZip64EndOfCentralDirectoryLocatorOffset(u64, u64),
    #[error("the zip64 end of central directory record size ({0}) was smaller than the minimum 44 bytes")]
    InvalidZip64EndOfCentralDirectorySize(u64),
    #[error(
        "the {field} in the end of central directory record ({legacy:#x}) did not match the zip64 end record ({zip64:#x})"
    )]
    MismatchedZip64EndOfCentralDirectoryField { field: &'static str, legacy: u64, zip64: u64 },
    #[error(
        "zip64 extended information field was too long: expected {expected} bytes, but {actual} bytes were provided"
    )]
    Zip64ExtendedInformationFieldTooLong { expected: usize, actual: usize },
}
