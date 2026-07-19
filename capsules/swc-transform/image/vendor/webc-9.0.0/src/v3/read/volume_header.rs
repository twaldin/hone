use std::{
    str::Utf8Error,
    time::{Duration, SystemTime},
};

use crate::{
    v3::{
        read::scanner::{InvalidSize, Scanner},
        Tag, Timestamps,
    },
    PathSegment, PathSegments,
};

/// A volume's (lazily parsed) metadata section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VolumeHeader<'buf> {
    header: &'buf [u8],
}

impl<'buf> VolumeHeader<'buf> {
    pub(crate) fn new(header: &'buf [u8]) -> Self {
        VolumeHeader { header }
    }

    pub(crate) fn root_directory(&self) -> Result<DirectoryMetadata<'buf>, VolumeHeaderError> {
        let scanner = Scanner::new(self.header);

        match HeaderEntry::parse(self.header, scanner)? {
            HeaderEntry::Directory(d) => Ok(d),
            HeaderEntry::File(_) => Err(VolumeHeaderError::NotADirectory),
        }
    }

    pub(crate) fn find(
        &self,
        path: &PathSegments,
    ) -> Result<Option<(HeaderEntry<'buf>, [u8; 32])>, VolumeHeaderError> {
        let root = self.root_directory()?;
        let hash = root.hash;
        root.find(&path.0, hash)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HeaderEntry<'buf> {
    Directory(DirectoryMetadata<'buf>),
    File(FileMetadata),
}

impl<'buf> HeaderEntry<'buf> {
    pub(crate) fn into_dir(self) -> Option<DirectoryMetadata<'buf>> {
        match self {
            HeaderEntry::Directory(d) => Some(d),
            HeaderEntry::File(_) => None,
        }
    }

    fn parse(header: &'buf [u8], mut scanner: Scanner<'buf>) -> Result<Self, VolumeHeaderError> {
        let [tag] = scanner.read()?;
        let tag = Tag::from_u8(tag).ok_or(VolumeHeaderError::UnknownTag { tag })?;

        match tag {
            Tag::Directory => DirectoryMetadata::parse(header, scanner).map(HeaderEntry::Directory),
            Tag::File => FileMetadata::parse(scanner).map(HeaderEntry::File),
            other => Err(VolumeHeaderError::UnsupportedHeaderEntry { tag: other }),
        }
    }

    fn find(
        self,
        path: &[PathSegment],
        hash: [u8; 32],
    ) -> Result<Option<(HeaderEntry<'buf>, [u8; 32])>, VolumeHeaderError> {
        match self {
            HeaderEntry::Directory(dir) => {
                let hash = dir.hash;

                dir.find(path, hash)
            }
            HeaderEntry::File(_) if !path.is_empty() => {
                // The "/path/to" in "/path/to/file.txt" is actually a file.
                Ok(None)
            }
            HeaderEntry::File(_) => Ok(Some((self, hash))),
        }
    }
}

/// Metadata about a file entry.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub(crate) struct FileMetadata {
    /// The start of the file, relative to the start of the volume's data
    /// section.
    pub(crate) start_offset: usize,
    /// The index one byte after the end of the file, relative to the start of
    /// the volume's data section.
    pub(crate) end_offset: usize,
    /// A SHA-256 checksum of the file.
    pub(crate) checksum: [u8; 32],

    pub(crate) timestamps: Timestamps,
}

impl FileMetadata {
    fn parse(mut scanner: Scanner<'_>) -> Result<FileMetadata, VolumeHeaderError> {
        let start_offset = scanner.read_usize()?;
        let end_offset = scanner.read_usize()?;
        let checksum = scanner.read()?;

        let _accessed = bytes_to_time(scanner.read()?)?;
        let modified = bytes_to_time(scanner.read()?)?;
        let _created = bytes_to_time(scanner.read()?)?;

        let timestamps = Timestamps { modified };

        Ok(FileMetadata {
            start_offset,
            end_offset,
            checksum,
            timestamps,
        })
    }
}

/// Metadata about a directory in a volume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirectoryMetadata<'buf> {
    timestamps: Timestamps,
    header: &'buf [u8],
    entries: Scanner<'buf>,
    hash: [u8; 32],
}

impl<'buf> DirectoryMetadata<'buf> {
    pub(crate) fn timestamps(&self) -> Timestamps {
        self.timestamps
    }

    fn parse(header: &'buf [u8], mut scanner: Scanner<'buf>) -> Result<Self, VolumeHeaderError> {
        let length = scanner.read_usize()?;
        let mut entries = scanner.truncated(length)?;

        let _accessed = bytes_to_time(entries.read()?)?;
        let modified = bytes_to_time(entries.read()?)?;
        let _created = bytes_to_time(entries.read()?)?;

        let timestamps = Timestamps { modified };

        let hash: [u8; 32] = entries.read()?;

        Ok(DirectoryMetadata {
            header,
            entries,
            timestamps,
            hash,
        })
    }

    /// Get an iterator over the entries in this directory and their names.
    pub(crate) fn entries(
        self,
    ) -> impl Iterator<Item = Result<(&'buf str, [u8; 32], HeaderEntry<'buf>), VolumeHeaderError>>
    {
        let header = self.header;

        self.child_offsets().map(|result| {
            let (name, hash, offset) = result?;

            // Note: This can error out because the input contained an invalid
            // offset for the directory entry.
            let rest = header
                .get(offset..)
                .ok_or(VolumeHeaderError::AccessOutOfBounds {
                    offset,
                    header_length: header.len(),
                })?;

            let scanner = Scanner::new(rest).with_current_position(offset);
            HeaderEntry::parse(header, scanner).map(|entry| (name, hash, entry))
        })
    }

    fn child_offsets(
        self,
    ) -> impl Iterator<Item = Result<(&'buf str, [u8; 32], usize), VolumeHeaderError>> {
        let mut scanner = self.entries.clone();

        std::iter::from_fn(move || {
            if scanner.is_empty() {
                return None;
            }

            match read_directory_entry(&mut scanner) {
                Ok((name, hash, offset)) => Some(Ok((name, hash, offset))),
                Err(e) => {
                    // Clear the scanner so we stop iterating
                    scanner = Scanner::new(&[]);
                    Some(Err(e))
                }
            }
        })
    }

    fn find(
        self,
        path: &[PathSegment],
        hash: [u8; 32],
    ) -> Result<Option<(HeaderEntry<'buf>, [u8; 32])>, VolumeHeaderError> {
        match path {
            [first, rest @ ..] => {
                for result in self.entries() {
                    let (name, hash, entry) = result?;
                    if name == *first {
                        return entry.find(rest, hash);
                    }
                }

                Ok(None)
            }
            [] => Ok(Some((HeaderEntry::Directory(self), hash))),
        }
    }
}

fn read_directory_entry<'buf>(
    scanner: &mut Scanner<'buf>,
) -> Result<(&'buf str, [u8; 32], usize), VolumeHeaderError> {
    let offset = scanner.read_usize()?;
    let hash: [u8; 32] = scanner.read()?;
    let text_length = scanner.read_usize()?;
    let text = scanner.take(text_length)?;
    let text = std::str::from_utf8(text).map_err(|error| VolumeHeaderError::InvalidFilename {
        error,
        filename: text.to_vec(),
    })?;

    Ok((text, hash, offset))
}

fn bytes_to_time(bytes: [u8; 8]) -> Result<SystemTime, VolumeHeaderError> {
    let duration = Duration::from_secs(u64::from_le_bytes(bytes));

    SystemTime::UNIX_EPOCH
        .checked_add(duration)
        .ok_or(VolumeHeaderError::InvalidTime { duration })
}

/// Errors that may occur while reading a volume header.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum VolumeHeaderError {
    /// The item wasn't found.
    #[error("The item wasn't found")]
    NotFound,
    /// Tried to access something outside of the volume header.
    #[error("Memory access outside of the volume header")]
    AccessOutOfBounds { offset: usize, header_length: usize },
    /// A filename wasn't valid UTF-8.
    #[error(
        "\"{}\" is not a valid UTF-8 string",
        String::from_utf8_lossy(filename)
    )]
    InvalidFilename {
        /// The underlying error.
        #[source]
        error: Utf8Error,
        /// The original filename.
        filename: Vec<u8>,
    },
    /// Encountered an entry with a tag that isn't supported.
    #[error("Expected a header entry, but found a section tagged with {tag}")]
    UnsupportedHeaderEntry {
        /// The tag that was encountered.
        tag: Tag,
    },
    /// Encountered a [`Tag`] with an known value.
    #[error("Unknown section tag: {tag:#x}")]
    UnknownTag {
        /// The raw value.
        tag: u8,
    },
    /// Found a directory when one wasn't expected (e.g. when looking up a
    /// file's data).
    #[error("Not a directory")]
    NotADirectory,

    #[error("Time cannot be represented as SystemTime: {duration:?}")]
    InvalidTime { duration: Duration },
}

impl From<InvalidSize> for VolumeHeaderError {
    fn from(value: InvalidSize) -> Self {
        let InvalidSize { expected, actual } = value;
        VolumeHeaderError::AccessOutOfBounds {
            offset: expected,
            header_length: actual,
        }
    }
}

#[cfg(test)]
mod tests {
    use sha2::Digest;

    use crate::utils::{length_field, sha256};

    use super::*;

    #[test]
    fn parse_empty_directory() {
        let timestamps = Timestamps::default();
        let empty_hash: [u8; 32] = sha2::Sha256::new().finalize().into();

        let header = bytes! {
            // ---- root directory ----
            Tag::Directory,
            56_u64.to_le_bytes(),
            timestamps,
            empty_hash,
        };

        let volume_header = VolumeHeader::new(&header);
        let entries = volume_header
            .root_directory()
            .unwrap()
            .entries()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(entries.is_empty());
    }

    #[test]
    fn directory_with_single_file() {
        let timestamps = Timestamps {
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(0_000_000_000),
        };
        let file3_txt = b"Hello, World!";

        let file_hash: [u8; 32] = sha2::Sha256::digest(file3_txt).into();
        let dir_hash: [u8; 32] = sha2::Sha256::digest(file_hash).into();

        let header = bytes! {
            // ---- Root directory ----
            Tag::Directory,
            // overall length of this directory section
            113_u64.to_le_bytes(),
            // timestamps
            Timestamps::default(),
            // hash
            dir_hash,
            // entries
            122_u64.to_le_bytes(),
            file_hash,
            length_field("file3.txt"),
            "file3.txt",

            // ---- /file3.txt ----
            Tag::File,
            0_u64.to_le_bytes(),
            length_field(file3_txt),
            sha256(file3_txt),
            timestamps
        };

        let directory = DirectoryMetadata::parse(&header, Scanner::new(&header[1..])).unwrap();
        let entries = directory.entries().collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(
            entries,
            vec![(
                "file3.txt",
                file_hash,
                HeaderEntry::File(FileMetadata {
                    start_offset: 0,
                    end_offset: file3_txt.len(),
                    checksum: sha256(file3_txt),
                    timestamps,
                })
            ),]
        );
    }

    #[test]
    fn directory_with_single_child_directory() {
        let root_timestamps = Timestamps {
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(0_000_000_000),
        };

        let other_timestamps = Timestamps {
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(0_000_000_000),
        };

        let empty_hash: [u8; 32] = sha2::Sha256::new().finalize().into();
        let dir_hash: [u8; 32] = sha2::Sha256::digest(empty_hash).into();

        let header = bytes! {
            // ---- root directory ----
            Tag::Directory,
            109_u64.to_le_bytes(),
            // timestamps
            root_timestamps,
            // hash
            dir_hash,
            // first entry
            118_u64.to_le_bytes(),
            empty_hash,
            length_field("other"),
            "other",

            // ---- "/other" ----
            Tag::Directory,
            56_u64.to_le_bytes(),
            // timestamps
            other_timestamps,
            // hash
            empty_hash
        };
        hexdump::hexdump(&header);

        let directory = DirectoryMetadata::parse(&header, Scanner::new(&header[1..])).unwrap();
        assert_eq!(directory.timestamps, root_timestamps);

        let entries = directory.entries().collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(
            entries,
            vec![(
                "other",
                empty_hash,
                HeaderEntry::Directory(DirectoryMetadata {
                    header: &header,
                    entries: Scanner::new(&[]).with_current_position(183),
                    timestamps: other_timestamps,
                    hash: empty_hash,
                })
            )]
        );
    }

    #[test]
    fn directory_with_multiple_children() {
        let file1_hash: [u8; 32] = sha2::Sha256::digest(b"fiest").into();
        let xyz_hash: [u8; 32] = sha2::Sha256::digest(b"second").into();
        let file2_hash: [u8; 32] = sha2::Sha256::digest(b"third").into();

        let mut dir_hasher = sha2::Sha256::new();
        dir_hasher.update(file1_hash);
        dir_hasher.update(file2_hash);
        dir_hasher.update(xyz_hash);
        let dir_hash: [u8; 32] = dir_hasher.finalize().into();

        let header = bytes! {
                // ---- Root directory ----
                Tag::Directory,
                225_u64.to_le_bytes(),
                Timestamps::default(),
                dir_hash,
                // first entry
                234_u64.to_le_bytes(),
                file1_hash,
                length_field("file1.txt"),
                "file1.txt",
                // second entry
                307_u64.to_le_bytes(),
                file2_hash,
                length_field("file2.txt"),
                "file2.txt",
                // third entry
                380_u64.to_le_bytes(),
                xyz_hash,
                length_field("xyz.txt"),
                "xyz.txt",

                // ---- /file1.txt ----
                Tag::File,
                0_u64.to_le_bytes(),
                5_u64.to_le_bytes(),
                sha256("first"),
                Timestamps::default(),
                // --- "file2.txt" ---
                Tag::File,
                5_u64.to_le_bytes(),
                10_u64.to_le_bytes(),
                sha256("third"),
                Timestamps::default(),
                // --- "xyz.txt" ---
                Tag::File,
                10_u64.to_le_bytes(),
                16_u64.to_le_bytes(),
                sha256("second"),
                Timestamps::default(),
        };
        hexdump::hexdump(&header);

        let directory = DirectoryMetadata::parse(&header, Scanner::new(&header[1..])).unwrap();
        let entries = directory.entries().collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(
            entries,
            vec![
                (
                    "file1.txt",
                    file1_hash,
                    HeaderEntry::File(FileMetadata {
                        start_offset: 0,
                        end_offset: 5,
                        checksum: sha256("first"),
                        timestamps: Timestamps::default(),
                    })
                ),
                (
                    "file2.txt",
                    file2_hash,
                    HeaderEntry::File(FileMetadata {
                        start_offset: 5,
                        end_offset: 10,
                        checksum: sha256("third"),
                        timestamps: Timestamps::default(),
                    })
                ),
                (
                    "xyz.txt",
                    xyz_hash,
                    HeaderEntry::File(FileMetadata {
                        start_offset: 10,
                        end_offset: 16,
                        checksum: sha256("second"),
                        timestamps: Timestamps::default(),
                    })
                ),
            ]
        );
    }
}
