use std::{fmt::Debug, sync::Arc};

use shared_buffer::OwnedBuffer;

use crate::{
    container::ContainerError, PathSegment, PathSegmentError, PathSegments, Timestamps,
    ToPathSegments,
};

/// A WEBC volume.
///
/// A `Volume` represents a collection of files and directories, providing
/// methods to read file contents and traverse directories.
///
/// # Example
///
/// ```
/// #[cfg(not(feature = "v3"))]
/// # fn main() {}
/// #[cfg(feature = "v3")]
/// # fn main() {
/// use webc::{Metadata, Volume, Version};
/// # use webc::{
/// #     compat::Container,
/// #     PathSegment,
/// #     v3::{
/// #         write::{Directory, Writer},
/// #         read::OwnedReader,
/// #         SignatureAlgorithm,
/// #         Timestamps
/// #     },
/// # };
/// # use sha2::Digest;
///
/// fn get_webc_volume() -> Volume {
///     /* ... */
/// # let dir = Directory::new(
/// #   [
/// #       (
/// #           PathSegment::parse("path").unwrap(),
/// #           Directory::new(
/// #               [
/// #                   (
/// #                       PathSegment::parse("to").unwrap(),
/// #                       Directory::new(
/// #                           [
/// #                               (PathSegment::parse("file.txt").unwrap(), b"Hello, World!".to_vec().into()),
/// #                           ].into_iter().collect(),
/// #                           Timestamps::default(),
/// #                       ).into(),
/// #                   ),
/// #               ].into_iter().collect(),
///                 Timestamps::default(),
/// #           ).into(),
/// #       ),
/// #       (
/// #           PathSegment::parse("another.txt").unwrap(),
/// #           b"Another".to_vec().into(),
/// #       ),
/// #   ].into_iter().collect(),
/// #   Timestamps::default(),
/// # );
/// # let serialized = Writer::default()
/// #     .write_manifest(&webc::metadata::Manifest::default()).unwrap()
/// #     .write_atoms(std::collections::BTreeMap::new()).unwrap()
/// #     .with_volume("my_volume", dir).unwrap()
/// #     .finish(SignatureAlgorithm::None).unwrap();
/// # Container::from_bytes_and_version(serialized.into(), Version::V3).unwrap().get_volume("my_volume").unwrap()
/// }
/// let another_hash: [u8; 32] = sha2::Sha256::digest(b"Another").into();
/// let file_hash: [u8; 32] = sha2::Sha256::digest(b"Hello, World!").into();
/// let to_hash: [u8; 32] = sha2::Sha256::digest(&file_hash).into();
/// let path_hash: [u8; 32] = sha2::Sha256::digest(&to_hash).into();
///
/// let volume = get_webc_volume();
/// // Accessing file content.
/// let (content, hash) = volume.read_file("/path/to/file.txt").unwrap();
/// assert_eq!(content, b"Hello, World!");
/// assert_eq!(hash, Some(file_hash));
/// // Inspect directories.
/// let timestamps = Some(webc::Timestamps::default());
/// let entries = volume.read_dir("/").unwrap();
///
/// assert_eq!(entries.len(), 2);
/// assert_eq!(entries[0], (
///     PathSegment::parse("another.txt").unwrap(),
///     Some(another_hash),
///     Metadata::File { length: 7, timestamps },
/// ));
/// assert_eq!(entries[1], (
///     PathSegment::parse("path").unwrap(),
///     Some(path_hash),
///     Metadata::Dir { timestamps },
/// ));
/// # }
/// ```
#[derive(Debug, Clone)]
pub struct Volume {
    imp: Arc<dyn AbstractVolume + Send + Sync + 'static>,
}

impl From<Arc<dyn AbstractVolume + Send + Sync + 'static>> for Volume {
    fn from(value: Arc<dyn AbstractVolume + Send + Sync + 'static>) -> Self {
        Self { imp: value }
    }
}

#[cfg(feature = "v2")]
impl From<crate::v2::read::VolumeSection> for Volume {
    fn from(value: crate::v2::read::VolumeSection) -> Self {
        Self {
            imp: Arc::new(value),
        }
    }
}

#[cfg(feature = "v3")]
impl From<crate::v3::read::VolumeSection> for Volume {
    fn from(value: crate::v3::read::VolumeSection) -> Self {
        Self {
            imp: Arc::new(value),
        }
    }
}

#[cfg(feature = "v1")]
impl From<v1::VolumeV1> for Volume {
    fn from(value: v1::VolumeV1) -> Self {
        Self {
            imp: Arc::new(value),
        }
    }
}

impl Volume {
    /// Get the metadata of an item at the given path.
    ///
    /// Returns `None` if the item does not exist in the volume or an internal
    /// error occurred.
    pub fn metadata(&self, path: impl ToPathSegments) -> Option<Metadata> {
        let path = path.to_path_segments().ok()?;
        self.imp.metadata(&path)
    }

    /// Read the contents of a directory at the given path.
    ///
    /// Returns a vector of directory entries, including their metadata, if the
    /// path is a directory.
    ///
    /// Returns `None` if the path does not exist or is not a directory.
    #[allow(clippy::type_complexity)] // Can't break an already-published API
    pub fn read_dir(
        &self,
        path: impl ToPathSegments,
    ) -> Option<Vec<(PathSegment, Option<[u8; 32]>, Metadata)>> {
        let path = path.to_path_segments().ok()?;
        self.imp.read_dir(&path)
    }

    /// Read the contents of a file at the given path.
    ///
    /// Returns `None` if the path is not valid or the file is not found.
    pub fn read_file(&self, path: impl ToPathSegments) -> Option<(OwnedBuffer, Option<[u8; 32]>)> {
        let path = path.to_path_segments().ok()?;
        self.imp.read_file(&path)
    }

    /// Unpack a subdirectory of this volume into a local directory.
    ///
    /// Use '/' as the volume_path to unpack the entire volume.
    #[allow(clippy::result_large_err)]
    pub fn unpack(
        &self,
        volume_path: impl ToPathSegments,
        out_dir: &std::path::Path,
    ) -> Result<(), ContainerError> {
        std::fs::create_dir_all(out_dir).map_err(|err| ContainerError::Open {
            path: out_dir.to_path_buf(),
            error: err,
        })?;

        let path = volume_path.to_path_segments()?;

        for (name, _, entry) in self.read_dir(&path).unwrap_or_default() {
            match entry {
                Metadata::Dir { .. } => {
                    let out_nested = out_dir.join(name.as_str());
                    self.unpack(path.join(name), &out_nested)?;
                }
                Metadata::File { .. } => {
                    let out_path = out_dir.join(name.as_str());
                    let p = path.join(name.clone());

                    if let Some((f, _)) = self.read_file(p) {
                        std::fs::write(&out_path, f.as_slice()).map_err(|err| {
                            ContainerError::Open {
                                path: out_path,
                                error: err,
                            }
                        })?;
                    }
                }
            }
        }

        Ok(())
    }
}

/// Metadata describing the properties of a file or directory.
#[derive(Debug, Copy, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Metadata {
    /// A directory
    Dir {
        /// Timestamps fo the directory
        timestamps: Option<Timestamps>,
    },
    /// A file with a specified length.
    File {
        /// The number of bytes in this file.
        length: usize,
        /// Timestamps of the file
        timestamps: Option<Timestamps>,
    },
}

impl Metadata {
    /// Returns `true` if the metadata represents a directory.
    pub fn is_dir(self) -> bool {
        matches!(self, Metadata::Dir { .. })
    }

    /// Returns `true` if the metadata represents a file.
    pub fn is_file(self) -> bool {
        matches!(self, Metadata::File { .. })
    }

    /// Returns the timestamps of the directory or file.
    pub fn timestamps(&self) -> Option<Timestamps> {
        let timestamps = match self {
            Metadata::Dir { timestamps } => timestamps,
            Metadata::File { timestamps, .. } => timestamps,
        };

        *timestamps
    }

    /// Returnes mutable ref to the timestamps of the directory or file.
    pub fn timestamps_mut(&mut self) -> Option<&mut Timestamps> {
        let timestamps = match self {
            Metadata::Dir { timestamps } => timestamps.as_mut(),
            Metadata::File { timestamps, .. } => timestamps.as_mut(),
        };

        timestamps
    }
}

// TODO: This will probably need redesigning later on to make `DirEntry`
// "remember" where it is within a directory structure. The current design
//  turns directory walking into an O(n²) operation.
/// Abstraction over different volume implementations
pub trait AbstractVolume: Debug {
    /// Returns the metadata of the entry associated with `path`
    fn metadata(&self, path: &PathSegments) -> Option<Metadata>;
    /// Returns the entries of `path`
    #[allow(clippy::type_complexity)] // Can't break an already-published API
    fn read_dir(
        &self,
        path: &PathSegments,
    ) -> Option<Vec<(PathSegment, Option<[u8; 32]>, Metadata)>>;
    /// Returnes the contents of the file associated with `path` and optionally, its hash
    fn read_file(&self, path: &PathSegments) -> Option<(OwnedBuffer, Option<[u8; 32]>)>;
}

#[cfg(feature = "v2")]
mod v2 {
    use super::*;

    impl AbstractVolume for crate::v2::read::VolumeSection {
        fn metadata(&self, path: &PathSegments) -> Option<Metadata> {
            let entry = self.header().find(path).ok().flatten()?;
            Some(v2_metadata(&entry))
        }

        fn read_dir(
            &self,
            path: &PathSegments,
        ) -> Option<Vec<(PathSegment, Option<[u8; 32]>, Metadata)>> {
            let meta = self
                .header()
                .find(path)
                .ok()
                .flatten()
                .and_then(|entry| entry.into_dir())?;

            let mut entries = Vec::new();

            for (name, entry) in meta.entries().flatten() {
                let segment: PathSegment = name.parse().unwrap();
                let meta = v2_metadata(&entry);
                entries.push((segment, None, meta));
            }

            Some(entries)
        }

        fn read_file(&self, path: &PathSegments) -> Option<(OwnedBuffer, Option<[u8; 32]>)> {
            self.lookup_file(path).map(|b| (b, None)).ok()
        }
    }

    fn v2_metadata(header_entry: &crate::v2::read::volume_header::HeaderEntry<'_>) -> Metadata {
        match header_entry {
            crate::v2::read::volume_header::HeaderEntry::Directory(_) => {
                Metadata::Dir { timestamps: None }
            }
            crate::v2::read::volume_header::HeaderEntry::File(
                crate::v2::read::volume_header::FileMetadata {
                    start_offset,
                    end_offset,
                    ..
                },
            ) => Metadata::File {
                length: end_offset - start_offset,
                timestamps: None,
            },
        }
    }
}

#[cfg(feature = "v3")]
mod v3 {
    use super::*;

    impl AbstractVolume for crate::v3::read::VolumeSection {
        fn metadata(&self, path: &PathSegments) -> Option<Metadata> {
            let (entry, _) = self.header().find(path).ok().flatten()?;
            Some(v3_metadata(&entry))
        }

        fn read_dir(
            &self,
            path: &PathSegments,
        ) -> Option<Vec<(PathSegment, Option<[u8; 32]>, Metadata)>> {
            let meta = self
                .header()
                .find(path)
                .ok()
                .flatten()
                .and_then(|(entry, _)| entry.into_dir())?;

            let mut entries = Vec::new();

            for (name, hash, entry) in meta.entries().flatten() {
                let segment: PathSegment = name.parse().unwrap();
                let meta = v3_metadata(&entry);
                entries.push((segment, Some(hash), meta));
            }

            Some(entries)
        }

        fn read_file(&self, path: &PathSegments) -> Option<(OwnedBuffer, Option<[u8; 32]>)> {
            self.lookup_file(path).map(|(b, h)| (b, Some(h))).ok()
        }
    }

    fn v3_metadata(header_entry: &crate::v3::read::volume_header::HeaderEntry<'_>) -> Metadata {
        match header_entry {
            crate::v3::read::volume_header::HeaderEntry::Directory(dir) => Metadata::Dir {
                timestamps: Some(dir.timestamps().into()),
            },
            crate::v3::read::volume_header::HeaderEntry::File(
                crate::v3::read::volume_header::FileMetadata {
                    start_offset,
                    end_offset,
                    timestamps,
                    ..
                },
            ) => Metadata::File {
                length: end_offset - start_offset,
                timestamps: Some((*timestamps).into()),
            },
        }
    }
}

#[cfg(feature = "v1")]
pub(crate) mod v1 {
    use super::*;

    #[derive(Debug)]
    pub(crate) struct VolumeV1 {
        // SAFETY: order is important here because volume has references into
        // bytes.
        pub(crate) volume: crate::v1::Volume<'static>,
        pub(crate) buffer: OwnedBuffer,
    }

    impl VolumeV1 {
        fn get_shared(&self, needle: &[u8]) -> OwnedBuffer {
            if needle.is_empty() {
                return OwnedBuffer::new();
            }

            let range = crate::utils::subslice_offsets(&self.buffer, needle);
            self.buffer.slice(range)
        }
    }

    impl AbstractVolume for VolumeV1 {
        fn metadata(&self, path: &PathSegments) -> Option<Metadata> {
            let path = path.to_string();

            if let Ok(bytes) = self.volume.get_file(&path) {
                return Some(Metadata::File {
                    length: bytes.len(),
                    timestamps: None,
                });
            }

            if self.volume.read_dir(&path).is_ok() {
                return Some(Metadata::Dir { timestamps: None });
            }

            None
        }

        fn read_dir(
            &self,
            path: &PathSegments,
        ) -> Option<Vec<(PathSegment, Option<[u8; 32]>, Metadata)>> {
            let path = path.to_string();

            let mut entries = Vec::new();

            for entry in self.volume.read_dir(&path).ok()? {
                let name: PathSegment = match entry.text.parse() {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let meta = v1_metadata(&entry);
                entries.push((name, None, meta));
            }

            Some(entries)
        }

        fn read_file(&self, path: &PathSegments) -> Option<(OwnedBuffer, Option<[u8; 32]>)> {
            let path = path.to_string();
            let bytes = self.volume.get_file(&path).ok()?;
            let owned_bytes = self.get_shared(bytes);

            Some((owned_bytes, None))
        }
    }

    fn v1_metadata(entry: &crate::v1::FsEntry<'_>) -> Metadata {
        match entry.fs_type {
            crate::v1::FsEntryType::File => Metadata::File {
                length: entry.get_len().try_into().unwrap(),
                timestamps: None,
            },
            crate::v1::FsEntryType::Dir => Metadata::Dir { timestamps: None },
        }
    }
}

/// Errors that may occur when doing [`Volume`] operations.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum VolumeError {
    /// The item wasn't found.
    #[error("The item wasn't found")]
    NotFound,
    /// The provided path wasn't valid.
    #[error("Invalid path")]
    Path(#[from] PathSegmentError),
    /// A non-directory was found where a directory was expected.
    #[error("Not a directory")]
    NotADirectory,
    /// A non-file was found where a file was expected.
    #[error("Not a file")]
    NotAFile,
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "v1")]
    mod v1 {
        use super::super::*;
        use crate::{v1::DirOrFile, volume::v1::VolumeV1};
        use std::collections::BTreeMap;

        fn owned_volume_v1(entries: BTreeMap<DirOrFile, Vec<u8>>) -> VolumeV1 {
            let bytes = crate::v1::Volume::serialize_files(entries);

            let borrowed_volume = crate::v1::Volume::parse(&bytes).unwrap();
            VolumeV1 {
                // SAFETY: We need to transmute the lifetime away.
                volume: unsafe { std::mem::transmute(borrowed_volume) },
                buffer: bytes.into(),
            }
        }

        #[test]
        fn v1_owned() {
            let mut dir = BTreeMap::new();
            dir.insert(DirOrFile::Dir("/path".into()), Vec::new());
            dir.insert(DirOrFile::Dir("/path/to".into()), Vec::new());
            dir.insert(
                DirOrFile::File("/path/to/file.txt".into()),
                b"Hello, World!".to_vec(),
            );
            dir.insert(DirOrFile::Dir("/path/to".into()), Vec::new());
            dir.insert(DirOrFile::File("/another.txt".into()), b"Another".to_vec());
            let volume = owned_volume_v1(dir);

            let volume = Volume::from(volume);

            assert!(volume.read_file("").is_none());
            assert_eq!(
                volume.read_file("/another.txt").unwrap(),
                (b"Another".as_slice().into(), None)
            );
            assert_eq!(
                volume.metadata("/another.txt").unwrap(),
                Metadata::File {
                    length: 7,
                    timestamps: None
                }
            );
            assert_eq!(
                volume.read_file("/path/to/file.txt").unwrap(),
                (b"Hello, World!".as_slice().into(), None),
            );

            assert_eq!(
                volume.metadata("/path/to").unwrap(),
                Metadata::Dir { timestamps: None },
            );
            assert_eq!(
                volume.read_dir("/").unwrap(),
                vec![
                    (
                        PathSegment::parse("another.txt").unwrap(),
                        None,
                        Metadata::File {
                            length: 7,
                            timestamps: None
                        }
                    ),
                    (
                        PathSegment::parse("path").unwrap(),
                        None,
                        Metadata::Dir { timestamps: None }
                    ),
                ],
            );
            assert_eq!(
                volume.read_dir("/path").unwrap(),
                vec![(
                    PathSegment::parse("to").unwrap(),
                    None,
                    Metadata::Dir { timestamps: None }
                )],
            );
            assert_eq!(
                volume.read_dir("/path/to/").unwrap(),
                vec![(
                    PathSegment::parse("file.txt").unwrap(),
                    None,
                    Metadata::File {
                        length: 13,
                        timestamps: None
                    }
                )],
            );
        }
    }

    #[cfg(feature = "v3")]
    mod v3 {
        use sha2::Digest;

        use super::super::*;
        use crate::{metadata::Manifest, v3::write::Writer};
        use std::collections::BTreeMap;

        fn v3_volume(
            volume: crate::v3::write::Directory<'static>,
        ) -> crate::v3::read::VolumeSection {
            let manifest = Manifest::default();
            let mut writer = Writer::default()
                .write_manifest(&manifest)
                .unwrap()
                .write_atoms(BTreeMap::new())
                .unwrap();
            writer.write_volume("volume", volume).unwrap();
            let serialized = writer.finish(crate::v3::SignatureAlgorithm::None).unwrap();
            let reader = crate::v3::read::OwnedReader::parse(serialized).unwrap();
            reader.get_volume("volume").unwrap()
        }

        #[test]
        fn v3() {
            let dir = dir_map! {
                "path" => dir_map! {
                    "to" => dir_map! {
                        "file.txt" => b"Hello, World!",
                    }
                },
                "another.txt" => b"Another",
            };

            let timestamps = Some(Timestamps::default());

            let volume = v3_volume(dir);

            let volume = Volume::from(volume);

            let another_hash: [u8; 32] = sha2::Sha256::digest(b"Another").into();
            let file_hash: [u8; 32] = sha2::Sha256::digest(b"Hello, World!").into();
            let to_hash: [u8; 32] = sha2::Sha256::digest(file_hash).into();
            let path_hash: [u8; 32] = sha2::Sha256::digest(to_hash).into();

            assert!(volume.read_file("").is_none());
            assert_eq!(
                volume.read_file("/another.txt").unwrap(),
                (b"Another".as_slice().into(), Some(another_hash))
            );
            assert_eq!(
                volume.metadata("/another.txt").unwrap(),
                Metadata::File {
                    length: 7,
                    timestamps
                }
            );
            assert_eq!(
                volume.read_file("/path/to/file.txt").unwrap(),
                (b"Hello, World!".as_slice().into(), Some(file_hash)),
            );
            assert_eq!(
                volume.read_dir("/").unwrap(),
                vec![
                    (
                        PathSegment::parse("another.txt").unwrap(),
                        Some(another_hash),
                        Metadata::File {
                            length: 7,
                            timestamps
                        },
                    ),
                    (
                        PathSegment::parse("path").unwrap(),
                        Some(path_hash),
                        Metadata::Dir { timestamps }
                    ),
                ],
            );
            assert_eq!(
                volume.read_dir("/path").unwrap(),
                vec![(
                    PathSegment::parse("to").unwrap(),
                    Some(to_hash),
                    Metadata::Dir { timestamps }
                )],
            );
            assert_eq!(
                volume.read_dir("/path/to/").unwrap(),
                vec![(
                    PathSegment::parse("file.txt").unwrap(),
                    Some(file_hash),
                    Metadata::File {
                        length: 13,
                        timestamps
                    }
                )],
            );
        }
    }
}
