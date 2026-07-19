use bytes::Bytes;

use crate::v2::{write::Section, Tag};

/// The algorithm used when signing a WEBC file.
#[derive(Debug, Default)]
#[non_exhaustive]
pub enum SignatureAlgorithm {
    /// Don't create a signature.
    #[default]
    None,
}

impl SignatureAlgorithm {
    pub(crate) fn begin(self) -> SignatureState {
        match self {
            SignatureAlgorithm::None => SignatureState::None,
        }
    }
}

#[derive(Debug)]
pub(crate) enum SignatureState {
    None,
}

impl SignatureState {
    pub(crate) fn update(&mut self, _section: &Section) -> Result<(), SignatureError> {
        match self {
            SignatureState::None => Ok(()),
        }
    }

    pub(crate) fn finish(self) -> Result<Signature, SignatureError> {
        match self {
            SignatureState::None => Ok(Signature::none()),
        }
    }
}

/// Errors that may occur when signing a WEBC file.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum SignatureError {
    /// An unknown error.
    #[error(transparent)]
    Other(Box<dyn std::error::Error + Send + Sync>),
}

/// A tagged signature.
///
/// Sometimes users may specify [`SignatureAlgorithm::None`] because they don't
/// want to sign their WEBC file. If this is the case, the signature will have a
/// [`Tag::SignatureNone`] tag and the value will be empty.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct Signature {
    /// What type of signature is this? (e.g. [`Tag::SignatureNone`])
    pub tag: Tag,
    /// The signature's value.
    pub value: Bytes,
}

impl Signature {
    /// The empty signature as used by [`Tag::SignatureNone`].
    pub const fn none() -> Self {
        Signature::new(Tag::SignatureNone, Bytes::new())
    }

    /// Create a new [`Signature`].
    pub const fn new(tag: Tag, value: Bytes) -> Self {
        Signature { tag, value }
    }

    /// Is this the empty signature (i.e. [`Tag::SignatureNone`]).
    pub const fn is_none(&self) -> bool {
        matches!(self.tag, Tag::SignatureNone)
    }
}
