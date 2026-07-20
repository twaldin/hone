// Copyright (c) 2021 Harry [Majored] [hello@majored.pw]
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

use crate::entry::ZipEntry;
use crate::error::{Result, ZipError};
use crate::spec::Compression;

pub(crate) const SPEC_VERSION_MADE_BY: u16 = 63;
pub(crate) const MAX_SUPPORTED_EXTRACT_VERSION: u16 = 63;
const DEFAULT_VERSION_NEEDED: u16 = 10;

/// Returns the minimum ZIP specification version required by a compression method.
// https://github.com/Majored/rs-async-zip/blob/main/SPECIFICATION.md#443
pub(crate) fn minimum_version_needed(compression: Compression) -> u16 {
    minimum_version_needed_for_method(compression.into())
}

fn minimum_version_needed_for_method(compression: u16) -> u16 {
    match compression {
        8 => 20,
        9 => 21,
        12 => 46,
        14 => 63,
        // APPNOTE does not assign method-specific minimum versions to every
        // supported compression method, so retain its default for those.
        _ => DEFAULT_VERSION_NEEDED,
    }
}

/// Validates the minimum extraction version for Deflate64 entries.
///
/// Deflate64 decoding can stop making progress when an entry declares a
/// contradictory legacy version.
///
/// Does not perform validation for other compression methods. A previous
/// attempt to do so for Deflate was blocked by prevalent use of legacy
/// versions, e.g., in GitHub source archive zips.
fn validate_deflate64_version(version: u16, compression: u16) -> Result<()> {
    if compression != 9 {
        return Ok(());
    }

    let required = minimum_version_needed_for_method(compression);
    if version < required {
        return Err(ZipError::InvalidCompressionVersion { version, required, compression });
    }

    Ok(())
}

pub(crate) fn validate_extract_version(raw_version: u16, compression: u16) -> Result<()> {
    // The extraction version occupies the low byte. The high byte is reserved,
    // but some writers populate it as though this were a "version made by" field.
    let version = raw_version & 0xff;
    if version > MAX_SUPPORTED_EXTRACT_VERSION {
        return Err(ZipError::FeatureNotSupported("zip file version > 6.3"));
    }

    validate_deflate64_version(version, compression)
}

// https://github.com/Majored/rs-async-zip/blob/main/SPECIFICATION.md#443
pub fn as_needed_to_extract(entry: &ZipEntry) -> u16 {
    let mut version = minimum_version_needed(entry.compression());

    if let Ok(true) = entry.dir() {
        version = std::cmp::max(version, 20);
    }

    version
}

// https://github.com/Majored/rs-async-zip/blob/main/SPECIFICATION.md#442
pub fn as_made_by() -> u16 {
    // Default to UNIX mapping for the moment.
    3 << 8 | SPEC_VERSION_MADE_BY
}

#[cfg(test)]
mod tests {
    use super::minimum_version_needed;
    use crate::spec::Compression;

    #[test]
    fn compression_minimum_versions_match_appnote() {
        assert_eq!(minimum_version_needed(Compression::Stored), 10);
        #[cfg(feature = "deflate")]
        assert_eq!(minimum_version_needed(Compression::Deflate), 20);
        #[cfg(feature = "deflate64")]
        assert_eq!(minimum_version_needed(Compression::Deflate64), 21);
        #[cfg(feature = "bzip2")]
        assert_eq!(minimum_version_needed(Compression::Bz), 46);
        #[cfg(feature = "lzma")]
        assert_eq!(minimum_version_needed(Compression::Lzma), 63);
        #[cfg(feature = "zstd")]
        assert_eq!(minimum_version_needed(Compression::Zstd), 10);
        #[cfg(feature = "xz")]
        assert_eq!(minimum_version_needed(Compression::Xz), 10);
    }
}
