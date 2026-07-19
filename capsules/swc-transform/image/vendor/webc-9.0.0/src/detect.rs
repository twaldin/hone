use std::io::Read;

use crate::{Magic, Version};

/// Check if the provided item looks like a WEBC file.
///
/// This function is a quick check to make sure the provided source has the WEBC
/// magic a version number, and will **not** do any expensive parsing or
/// validation.
///
/// ```rust
/// assert!(webc::is_webc(b"\0webc002"));
/// ```
///
/// This is just a specialised version of [`detect()`].
pub fn is_webc(reader: &[u8]) -> bool {
    detect(reader).is_ok()
}

/// Check whether something looks like a valid WEBC file and extract its
/// version number.
///
/// This will *not* apply any validation or check that the rest of the file
/// is correct.
///
/// # Examples
///
/// ```rust
/// # use webc::Version;
/// # fn main() -> Result<(), Box<dyn std::error::Error>> {
/// let buffer = b"\0webc002";
/// let version = webc::detect(&buffer[..])?;
/// assert_eq!(version, Version::V2);
/// # Ok(())
/// # }
/// ```
pub fn detect(mut reader: impl Read) -> Result<Version, DetectError> {
    let mut magic: Magic = [0; 5];
    reader.read_exact(&mut magic)?;
    if magic != crate::MAGIC {
        return Err(DetectError::InvalidMagic {
            found: magic,
            expected: crate::MAGIC,
        });
    }

    let mut version = Version([0; 3]);
    reader.read_exact(&mut version.0)?;

    Ok(version)
}

/// An error returned by [`detect()`].
#[derive(Debug, thiserror::Error)]
pub enum DetectError {
    /// An error occurred while reading.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The [`Magic`] bytes were invalid.
    #[error(
        "Expected the magic bytes to be \"{}\", but found \"{}\"",
        expected.escape_ascii(),
        found.escape_ascii(),
    )]
    InvalidMagic {
        /// The [`Magic`] bytes the file started with.
        found: Magic,
        /// The [`Magic`] bytes that were expected.
        expected: Magic,
    },
}
