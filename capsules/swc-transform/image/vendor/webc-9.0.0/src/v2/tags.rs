use std::fmt::{self, Display, Formatter, LowerHex, UpperHex};

/// Unique identifiers used to indicate various components of a WEBC file.
///
/// # Top-Level Sections
///
/// In general, all top-level sections are [Type-Length-Value][tlv] encoded.
///
/// - [`Tag`] (`u8`)
/// - Length (`u64` LE)
/// - Value (`Length` bytes)
///
/// # Versioning
///
/// Besides acting as an identifier for various elements in a WEBC file, the
/// [`Tag`] plays an important part in versioning. An item's layout is tied
/// to its [`Tag`], so any time the layout is changed, a new unique [`Tag`]
/// should be created.
///
/// For example, if the format for a volume needs to be changed, a new
/// `Tag::VolumeV2` variant would be added instead of modifying the spec for
/// existing volumes. Future reader implementations then need to handle
/// [`Tag::Volume`] and `Tag::VolumeV2` gracefully.
///
/// [tlv]: https://en.wikipedia.org/wiki/Type%E2%80%93length%E2%80%93value
#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[repr(u8)]
#[non_exhaustive]
#[serde(rename_all = "kebab-case")]
pub enum Tag {
    /*
        Top-level sections
    */
    /// The manifest section, containing a CBOR-serialized
    /// [`crate::metadata::Manifest`].
    Manifest = 1,
    /// The index section, containing a CBOR-serialized [`crate::v2::Index`].
    ///
    /// The index section is laid out as follows:
    ///
    /// - [`Tag::Index`]
    /// - overall section length (`u64` LE)
    /// - CBOR data
    /// - padding
    ///
    /// # Note to Implementors
    ///
    /// This section may contain trailing padding bytes that should be ignored
    /// when deserializing the index.
    ///
    /// Depending on the writer implementation, padding bytes may be necessary
    /// because the [`crate::v2::Index`] needs to be at the start of a WEBC file,
    /// yet it can only be calculated after everything has been serialized.
    Index = 2,
    /// The atoms section.
    ///
    /// An atoms section is laid out similar to [`Tag::Volume`].
    ///
    /// - [`Tag::Atoms`]
    /// - overall section length (`u64` LE)
    /// - volume header length (`u64` LE)
    /// - volume header
    /// - volume data length (`u64` LE)
    /// - volume data
    Atoms = 3,
    /// The volume section.
    ///
    /// A volume section is laid out similar to [`Tag::Atoms`].
    ///
    /// - [`Tag::Volume`]
    /// - overall section length
    /// - volume name length (`u64` LE)
    /// - volume name (`u64` LE)
    /// - volume header length (`u64` LE)
    /// - volume header
    /// - volume data length (`u64` LE)
    /// - volume data
    Volume = 4,

    /*
     *  Identifiers for components of the index.
     */
    /// A tag for the empty checksum (i.e. [`crate::v2::Checksum::none()`]).
    ChecksumNone = 20,
    /// A tag indicating that the [`crate::v2::Checksum`] is calculated using the
    /// SHA-256 hash of a section's contents.
    ///
    /// See also, [`crate::v2::Checksum::sha256()`].
    ChecksumSha256 = 21,
    /// A tag for the empty signature (i.e. [`crate::v2::Signature::none()`]).
    SignatureNone = 22,

    /*
     * Identifiers for components in a volume header.
     */
    /// Metadata for a directory in the [`Tag::Volume`] header.
    ///
    /// Each directory follows the type-length-value format.
    ///
    /// - [`Tag::Directory`]
    /// - overall directory length (`u64` LE)
    /// - zero or more entries
    ///
    /// Where each entry is
    ///
    /// - offset of the entry relative to the start of the header (`u64` LE)
    /// - name length (`u64` LE)
    /// - name (arbitrary number of bytes)
    Directory = 30,
    /// Metadata for a file in the [`Tag::Volume`] header.
    ///
    /// File metadata follows the following format:
    ///
    /// - [`Tag::File`]
    /// - start offset in data section (`u64` LE)
    /// - end offset in data section (`u64` LE)
    /// - SHA256 checksum (32 bytes)
    File = 31,
}

impl Tag {
    /// Get an iterator over all the tag variants.
    pub const ALL: [Tag; 9] = [
        Tag::Manifest,
        Tag::Index,
        Tag::Atoms,
        Tag::Volume,
        Tag::ChecksumNone,
        Tag::ChecksumSha256,
        Tag::SignatureNone,
        Tag::Directory,
        Tag::File,
    ];

    /// Try to load a [`Tag`] from its [`u8`] representation.
    pub const fn from_u8(tag: u8) -> Option<Self> {
        match tag {
            1 => Some(Tag::Manifest),
            2 => Some(Tag::Index),
            3 => Some(Tag::Atoms),
            4 => Some(Tag::Volume),
            20 => Some(Tag::ChecksumNone),
            21 => Some(Tag::ChecksumSha256),
            22 => Some(Tag::SignatureNone),
            30 => Some(Tag::Directory),
            31 => Some(Tag::File),
            _ => None,
        }
    }

    /// Get the [`Tag`]'s [`u8`] representation.
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    /// Get the [`Tag`]'s human-friendly name.
    pub const fn name(self) -> &'static str {
        match self {
            Tag::Manifest => "Manifest",
            Tag::Index => "Index",
            Tag::Atoms => "Atoms",
            Tag::Volume => "Volume",
            Tag::ChecksumNone => "No Checksum",
            Tag::ChecksumSha256 => "SHA-256 Checksum",
            Tag::SignatureNone => "No Signature",
            Tag::Directory => "Directory",
            Tag::File => "File",
        }
    }

    /// Gets a displayable implementation for something that may or may not be
    /// a known tag.
    ///
    /// Unknown tags are printed in their hexadecimal representation.
    pub fn display(maybe_tag: u8) -> impl Display {
        enum MaybeTag {
            Known(Tag),
            Unknown(u8),
        }
        impl Display for MaybeTag {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                match self {
                    MaybeTag::Known(tag) => Display::fmt(tag, f),
                    MaybeTag::Unknown(other) => write!(f, "{other:#x}"),
                }
            }
        }

        match Tag::from_u8(maybe_tag) {
            Some(tag) => MaybeTag::Known(tag),
            None => MaybeTag::Unknown(maybe_tag),
        }
    }
}

impl Display for Tag {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        Display::fmt(self.name(), f)
    }
}

impl LowerHex for Tag {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        LowerHex::fmt(&self.as_u8(), f)
    }
}

impl UpperHex for Tag {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        UpperHex::fmt(&self.as_u8(), f)
    }
}

impl PartialEq<u8> for Tag {
    fn eq(&self, other: &u8) -> bool {
        self.as_u8() == *other
    }
}

impl PartialEq<Tag> for u8 {
    fn eq(&self, other: &Tag) -> bool {
        other == self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_tags_round_trip() {
        for tag in Tag::ALL {
            let byte = tag.as_u8();
            let round_tripped = Tag::from_u8(byte).unwrap();
            assert_eq!(tag, round_tripped);
        }
    }
}
