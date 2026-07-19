use std::collections::BTreeMap;

use crate::{
    v2::{
        read::{
            volume_header::{DirectoryMetadata, FileMetadata, HeaderEntry},
            VolumeHeaderError,
        },
        Span,
    },
    PathSegmentError,
};
use shared_buffer::OwnedBuffer;

/// An item in a volume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirEntry<'volume> {
    Dir(Directory<'volume>),
    File(FileEntry),
}

impl<'volume> DirEntry<'volume> {
    fn from_metadata(
        metadata: HeaderEntry<'volume>,
        data_offset: usize,
        data_section: OwnedBuffer,
    ) -> Result<Self, DirEntryError> {
        match metadata {
            HeaderEntry::Directory(dir) => {
                Ok(Directory::new(dir, data_offset, data_section).into())
            }
            HeaderEntry::File(meta) => {
                let file = FileEntry::from_metadata(meta, data_offset, data_section)?;
                Ok(file.into())
            }
        }
    }

    /// Convert the [`DirEntry`] into a [`FileEntry`], if it is one.
    pub fn into_file(self) -> Option<FileEntry> {
        match self {
            DirEntry::File(f) => Some(f),
            _ => None,
        }
    }

    /// Convert the [`DirEntry`] into a [`Directory`], if it is one.
    pub fn into_dir(self) -> Option<Directory<'volume>> {
        match self {
            DirEntry::Dir(d) => Some(d),
            _ => None,
        }
    }
}

impl<'volume> From<Directory<'volume>> for DirEntry<'volume> {
    fn from(v: Directory<'volume>) -> Self {
        Self::Dir(v)
    }
}

impl From<FileEntry> for DirEntry<'_> {
    fn from(f: FileEntry) -> Self {
        Self::File(f)
    }
}

/// A directory that contains zero or more [`DirEntry`]'s.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directory<'volume> {
    metadata: DirectoryMetadata<'volume>,
    /// The offset of the data section, relative to the start of the volume.
    data_offset: usize,
    data_section: OwnedBuffer,
}

impl<'volume> Directory<'volume> {
    pub(crate) fn new(
        metadata: DirectoryMetadata<'volume>,
        data_offset: usize,
        data_section: OwnedBuffer,
    ) -> Self {
        Directory {
            metadata,
            data_offset,
            data_section,
        }
    }

    /// Lazily parse the entries in this directory.
    pub fn entries(
        &self,
    ) -> impl Iterator<Item = Result<(&'volume str, DirEntry<'volume>), DirEntryError>> + '_ {
        self.metadata.clone().entries().map(|result| {
            result
                .map_err(DirEntryError::from)
                .and_then(|(name, entry)| {
                    let entry = DirEntry::from_metadata(
                        entry,
                        self.data_offset,
                        self.data_section.clone(),
                    )?;
                    Ok((name, entry))
                })
        })
    }

    /// Look up a particular entry by name.
    pub fn find(&self, name: &str) -> Result<Option<DirEntry<'volume>>, DirEntryError> {
        for result in self.entries() {
            let (entry_name, entry) = result?;
            if name == entry_name {
                return Ok(Some(entry));
            }
        }

        Ok(None)
    }

    /// Is this directory empty?
    pub fn is_empty(&self) -> bool {
        self.entries().filter_map(|result| result.ok()).count() == 0
    }
}

/// The contents of a file in the volume.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FileEntry {
    data: OwnedBuffer,
    offset: usize,
    checksum: [u8; 32],
}

impl FileEntry {
    pub(crate) fn from_metadata(
        meta: FileMetadata,
        data_offset: usize,
        data_section: OwnedBuffer,
    ) -> Result<FileEntry, DirEntryError> {
        let FileMetadata {
            start_offset,
            end_offset,
            checksum,
        } = meta;

        if start_offset > data_section.len() || end_offset > data_section.len() {
            return Err(DirEntryError::FileOutOfBounds {
                start_offset,
                end_offset,
                data_section_length: data_section.len(),
            });
        }

        let data = data_section.slice(start_offset..end_offset);
        Ok(FileEntry {
            data,
            offset: data_offset + start_offset,
            checksum,
        })
    }

    /// The file's data.
    pub fn bytes(&self) -> &OwnedBuffer {
        &self.data
    }

    /// The length of the file.
    pub fn len(&self) -> usize {
        self.bytes().len()
    }

    /// Is the file empty?
    pub fn is_empty(&self) -> bool {
        self.bytes().is_empty()
    }

    /// The location of the file, relative to the start of its volume.
    pub fn span(&self) -> Span {
        Span::new(self.offset, self.len())
    }

    /// A SHA-256 checksum for this file.
    pub fn checksum(&self) -> [u8; 32] {
        self.checksum
    }
}

/// Errors that may occur while parsing a [`DirEntry`].
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum DirEntryError {
    #[error("The volume header was corrupted")]
    Header(#[from] VolumeHeaderError),
    #[error("File data is out of bounds ({start_offset}..{end_offset} is outside of 0..{data_section_length})")]
    FileOutOfBounds {
        start_offset: usize,
        end_offset: usize,
        data_section_length: usize,
    },
    #[error("\"{segment}\" is an invalid path segment")]
    InvalidPathSegment {
        #[source]
        error: PathSegmentError,
        segment: String,
    },
}

impl TryFrom<DirEntry<'_>> for crate::v2::write::DirEntry<'_> {
    type Error = DirEntryError;

    fn try_from(value: DirEntry<'_>) -> Result<Self, Self::Error> {
        match value {
            DirEntry::Dir(d) => d.try_into().map(crate::v2::write::DirEntry::Dir),
            DirEntry::File(f) => Ok(crate::v2::write::DirEntry::File(f.into())),
        }
    }
}

impl TryFrom<Directory<'_>> for crate::v2::write::Directory<'_> {
    type Error = DirEntryError;

    fn try_from(dir: Directory<'_>) -> Result<Self, Self::Error> {
        let mut children = BTreeMap::new();

        for result in dir.entries() {
            let (name, entry) = result?;
            let name = name
                .parse()
                .map_err(|error| DirEntryError::InvalidPathSegment {
                    error,
                    segment: name.to_string(),
                })?;
            children.insert(name, entry.try_into()?);
        }

        Ok(crate::v2::write::Directory { children })
    }
}

impl From<FileEntry> for crate::v2::write::FileEntry<'_> {
    fn from(value: FileEntry) -> Self {
        crate::v2::write::FileEntry::Owned(value.bytes().clone().into_bytes())
    }
}
