use bytes::Bytes;
use sha2::{Digest, Sha256};

use crate::v3::Tag;

#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ChecksumAlgorithm {
    None,
    #[default]
    Sha256,
}

impl ChecksumAlgorithm {
    pub fn is_none(self) -> bool {
        matches!(self, ChecksumAlgorithm::None)
    }

    pub fn calculate(self, buffer: &[u8]) -> Checksum {
        let mut state = ChecksumState::new(self);
        state.update(buffer);
        state.finish()
    }
}

#[derive(Debug, Clone)]
enum ChecksumState {
    None,
    Sha256(Sha256),
}

impl ChecksumState {
    fn new(algorithm: ChecksumAlgorithm) -> Self {
        match algorithm {
            ChecksumAlgorithm::None => ChecksumState::None,
            ChecksumAlgorithm::Sha256 => ChecksumState::Sha256(Sha256::default()),
        }
    }

    fn update(&mut self, bytes: &[u8]) {
        match self {
            ChecksumState::None => {
                // Nothing to do.
            }
            ChecksumState::Sha256(sha256) => sha256.update(bytes),
        }
    }

    fn finish(self) -> Checksum {
        match self {
            ChecksumState::None => Checksum::none(),
            ChecksumState::Sha256(sha256) => Checksum::sha256(sha256.finalize().into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct Checksum {
    pub tag: Tag,
    pub value: Bytes,
}

impl Checksum {
    pub const fn new(tag: Tag, value: Bytes) -> Self {
        Checksum { tag, value }
    }

    pub const fn none() -> Self {
        Checksum::new(Tag::ChecksumNone, Bytes::new())
    }

    pub fn sha256(hash: [u8; 32]) -> Self {
        Checksum {
            tag: Tag::ChecksumSha256,
            value: hash.to_vec().into(),
        }
    }

    pub const fn is_none(&self) -> bool {
        matches!(self.tag, Tag::ChecksumNone)
    }
}
