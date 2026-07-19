use std::collections::BTreeMap;

use crate::v2::{Checksum, Signature, Span};

/// The index added to a WEBC file to facilitate `O(1)` lookups for its
/// contents.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[non_exhaustive]
pub struct Index {
    pub manifest: IndexEntry,
    pub atoms: IndexEntry,
    pub volumes: BTreeMap<String, IndexEntry>,
    pub signature: Signature,
}

impl Index {
    /// Add a fixed offset to each [`Span`] in the [`Index`].
    pub(crate) fn with_offset(self, delta: usize) -> Index {
        let Index {
            mut manifest,
            mut atoms,
            mut volumes,
            signature,
        } = self;

        manifest.offset(delta);
        atoms.offset(delta);

        for section in volumes.values_mut() {
            section.offset(delta);
        }

        Index {
            manifest,
            atoms,
            volumes,
            signature,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[non_exhaustive]
pub struct IndexEntry {
    pub span: Span,
    pub checksum: Checksum,
}

impl IndexEntry {
    fn offset(&mut self, delta: usize) {
        self.span = self.span.with_offset(delta);
    }
}
