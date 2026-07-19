use std::{
    fmt::{self, Display, Formatter},
    ops::Deref,
};

/// A WEBC file's version number.
#[derive(
    Debug, Copy, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[repr(transparent)]
pub struct Version(pub [u8; 3]);

impl Version {
    /// The identifier for WEBC v1.
    pub const V1: Version = Version([b'0', b'0', b'1']);
    /// The identifier for WEBC v2.
    pub const V2: Version = Version([b'0', b'0', b'2']);
    /// The identifier for WEBC v3.
    pub const V3: Version = Version([b'0', b'0', b'3']);
    /// The identifier for the latest WEBC version.
    pub const LATEST: Version = Version::V3;

    #[cfg(feature = "v1")]
    pub(crate) const fn len(&self) -> usize {
        self.0.len()
    }
}

impl Default for Version {
    fn default() -> Self {
        Version::LATEST
    }
}

impl Display for Version {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.escape_ascii())
    }
}

impl Deref for Version {
    type Target = [u8; 3];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl PartialEq<[u8; 3]> for Version {
    fn eq(&self, other: &[u8; 3]) -> bool {
        self.0 == *other
    }
}

impl PartialEq<&[u8; 3]> for Version {
    fn eq(&self, other: &&[u8; 3]) -> bool {
        self.0 == **other
    }
}

impl PartialEq<&[u8]> for Version {
    fn eq(&self, other: &&[u8]) -> bool {
        self.0 == *other
    }
}

impl PartialEq<[u8]> for Version {
    fn eq(&self, other: &[u8]) -> bool {
        self.0 == *other
    }
}

impl PartialEq<Version> for [u8; 3] {
    fn eq(&self, other: &Version) -> bool {
        other == self
    }
}

impl PartialEq<Version> for &[u8; 3] {
    fn eq(&self, other: &Version) -> bool {
        other == self
    }
}

impl PartialEq<Version> for &[u8] {
    fn eq(&self, other: &Version) -> bool {
        other == self
    }
}

impl PartialEq<Version> for [u8] {
    fn eq(&self, other: &Version) -> bool {
        other == self
    }
}

impl From<[u8; 3]> for Version {
    fn from(raw: [u8; 3]) -> Self {
        Version(raw)
    }
}

impl From<&[u8; 3]> for Version {
    fn from(raw: &[u8; 3]) -> Self {
        Version::from(*raw)
    }
}

impl AsRef<[u8]> for Version {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl AsRef<[u8; 3]> for Version {
    fn as_ref(&self) -> &[u8; 3] {
        &self.0
    }
}
