//! Parsing code for v2 of the WEBC format.
#![allow(missing_docs)]

mod checksum;
mod index;
pub mod read;
mod signature;
mod span;
mod tags;
pub mod write;

pub use self::{
    checksum::{Checksum, ChecksumAlgorithm},
    index::{Index, IndexEntry},
    signature::{Signature, SignatureAlgorithm, SignatureError},
    span::Span,
    tags::Tag,
};
