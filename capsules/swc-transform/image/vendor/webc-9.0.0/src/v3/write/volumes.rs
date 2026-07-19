use std::{
    collections::BTreeMap,
    fmt,
    fs::File,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
};

use bytes::{BufMut, Bytes, BytesMut};
use sha2::{Digest, Sha256};

use crate::{
    readable_bytes,
    v3::{Span, Tag, Timestamps},
    DirectoryFromPathError, PathSegment,
};

/// The main parts of a volume.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct VolumeParts {
    pub(crate) header: Bytes,
    pub(crate) data: Bytes,
}

impl VolumeParts {
    pub(crate) fn serialize(dir: Directory<'_>) -> Result<Self, std::io::Error> {
        let serializer = Serializer::default();
        serializer.serialize(dir)
    }

    /// Finish serializing this into a named volume.
    pub(crate) fn volume(&self, name: &str) -> Bytes {
        let VolumeParts { header, data } = self;

        let mut buffer = BytesMut::with_capacity(
            header.len() + data.len() + name.len() + 3 * std::mem::size_of::<u64>(),
        );

        buffer.put_u64_le(name.len().try_into().unwrap());
        buffer.extend_from_slice(name.as_bytes());
        buffer.put_u64_le(header.len().try_into().unwrap());
        buffer.extend_from_slice(header);
        buffer.put_u64_le(data.len().try_into().unwrap());
        buffer.extend_from_slice(data);

        buffer.freeze()
    }

    /// Finish serializing this into the atoms volume.
    ///
    /// The atoms section is almost identical to a normal volume
    /// ([`VolumeParts::volume()`]), except it doesn't have a name.
    pub(crate) fn atoms(&self) -> Bytes {
        let VolumeParts { header, data } = self;

        let mut buffer =
            BytesMut::with_capacity(header.len() + data.len() + 2 * std::mem::size_of::<u64>());

        buffer.put_u64_le(header.len().try_into().unwrap());
        buffer.extend_from_slice(header);
        buffer.put_u64_le(data.len().try_into().unwrap());
        buffer.extend_from_slice(data);

        buffer.freeze()
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
struct Serializer {
    header: BytesMut,
    data: BytesMut,
}

impl Serializer {
    fn serialize(mut self, dir: Directory<'_>) -> Result<VolumeParts, std::io::Error> {
        self.serialize_directory(dir)?;
        let Serializer { header, data } = self;

        Ok(VolumeParts {
            header: header.freeze(),
            data: data.freeze(),
        })
    }

    fn serialize_dir_entry(
        &mut self,
        dir_entry: DirEntry<'_>,
    ) -> Result<(Span, [u8; 32]), std::io::Error> {
        match dir_entry {
            DirEntry::Dir(d) => self.serialize_directory(d),
            DirEntry::File(f) => self.serialize_file(f),
        }
    }

    fn serialize_directory(
        &mut self,
        dir: Directory<'_>,
    ) -> Result<(Span, [u8; 32]), std::io::Error> {
        const DUMMY_U64: [u8; std::mem::size_of::<u64>()] =
            [0xde, 0xad, 0xbe, 0xef, 0xba, 0xad, 0xc0, 0xde];

        let overall_start = self.header.len();
        self.header.put_u8(Tag::Directory.as_u8());

        // We'll fill in the length directory length field at the end
        let directory_length_ix = self.header.len();
        self.header.extend(DUMMY_U64);

        // Add the timestamps of the directory
        let timestamps_start = self.header.len();
        dir.timestamps.write_to(&mut self.header)?;

        // Add hash of the directory
        let mut hasher = sha2::Sha256::new();
        let hash_start = self.header.len();
        self.header.extend_from_slice(&[0; 32]);

        let mut offset_fields = BTreeMap::new();

        for name in dir.children.keys() {
            // each entry in a directory is stored as (offset, hash, name_length, name)

            // Note: we don't actually know where the entry will be placed in
            // the header, so let's write a dummy value and come back later.
            let ix = self.header.len();

            // offset
            self.header.extend(DUMMY_U64);
            // hash
            self.header.extend_from_slice(&[0; 32]);
            // name_length
            self.header
                .extend(u64::try_from(name.len()).unwrap().to_le_bytes());
            // name
            self.header.extend_from_slice(name.as_bytes());

            offset_fields.insert(name.clone(), ix);
        }

        let end = self.header.len();
        let span = Span::new(overall_start, end - overall_start);

        // Patch up the directory length
        let length = u64::try_from(end - timestamps_start).unwrap().to_le_bytes();
        self.header[directory_length_ix..directory_length_ix + length.len()]
            .copy_from_slice(&length);

        for (name, entry) in dir.children {
            let (Span { start, .. }, hash) = self.serialize_dir_entry(entry)?;

            // Now we've serialized the entry, we can fill in its offset
            let offset_field = offset_fields[&name];
            let offset = u64::try_from(start).unwrap().to_le_bytes();
            self.header[offset_field..offset_field + offset.len()].copy_from_slice(&offset);

            let hash_offset = offset_field + offset.len();

            self.header[hash_offset..hash_offset + hash.len()].copy_from_slice(hash.as_slice());

            // hash of a directory is the hash of all of its entries
            hasher.update(hash);
        }

        // Patch up the directory hash
        let hash: [u8; 32] = hasher.finalize().into();
        self.header[hash_start..hash_start + hash.len()].copy_from_slice(&hash);

        Ok((span, hash))
    }

    fn serialize_file(&mut self, file: FileEntry<'_>) -> Result<(Span, [u8; 32]), std::io::Error> {
        // First, we serialize the file's data
        let data_start = self.data.len();
        let mut cs = Sha256ChecksumWriter::new(BufMut::writer(&mut self.data));
        file.content.write_to(&mut cs)?;
        let checksum = cs.finish();
        let data_end = self.data.len();

        // Now, we can update the header with its metadata
        let start = self.header.len();

        // File tag
        self.header.put_u8(Tag::File.as_u8());
        // Data range
        self.header
            .extend(u64::try_from(data_start).unwrap().to_le_bytes());
        self.header
            .extend(u64::try_from(data_end).unwrap().to_le_bytes());
        self.header.extend(checksum);
        file.timestamps.write_to(&mut self.header)?;
        let end = self.header.len();

        Ok((Span::new(start, end - start), checksum))
    }
}

struct Sha256ChecksumWriter<W> {
    writer: W,
    state: Sha256,
}

impl<W> Sha256ChecksumWriter<W> {
    fn new(writer: W) -> Self {
        Sha256ChecksumWriter {
            writer,
            state: Sha256::default(),
        }
    }

    fn finish(self) -> [u8; 32] {
        self.state.finalize().into()
    }
}

impl<W: Write> Write for Sha256ChecksumWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let bytes_written = self.writer.write(buf)?;
        self.state.update(&buf[..bytes_written]);
        Ok(bytes_written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A directory in a volume.
#[non_exhaustive]
#[derive(Debug, Default)]
pub struct Directory<'a> {
    /// The items in this directory.
    pub children: BTreeMap<PathSegment, DirEntry<'a>>,
    pub timestamps: Timestamps,
}

impl<'a> Directory<'a> {
    pub fn new(children: BTreeMap<PathSegment, DirEntry<'a>>, timestamps: Timestamps) -> Self {
        Directory {
            children,
            timestamps,
        }
    }

    pub const fn with_timestamps(timestamps: Timestamps) -> Self {
        Directory {
            children: BTreeMap::new(),
            timestamps,
        }
    }
}

impl<'a> Extend<(PathSegment, DirEntry<'a>)> for Directory<'a> {
    fn extend<T: IntoIterator<Item = (PathSegment, DirEntry<'a>)>>(&mut self, iter: T) {
        self.children.extend(iter)
    }
}

impl Directory<'static> {
    /// Load a [`Directory`] from a directory on disk.
    pub fn from_path(directory: impl AsRef<Path>) -> Result<Self, std::io::Error> {
        let directory = directory.as_ref();

        let mut children: BTreeMap<PathSegment, DirEntry<'_>> = BTreeMap::new();

        for entry in directory.read_dir()? {
            let entry = entry?;
            let path = entry.path();

            let name = match path
                .strip_prefix(directory)
                .expect("The path was derived from our directory")
                .to_str()
            {
                Some(s) => s.parse().unwrap(),
                None => continue,
            };

            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                let dir = Directory::from_path(&path)?;
                children.insert(name, DirEntry::Dir(dir));
            } else {
                children.insert(name, DirEntry::File(FileEntry::from_path(path)?));
            }
        }

        let meta = directory.metadata()?;
        let timestamps = Timestamps::from_metadata(&meta)?;

        Ok(Directory {
            children,
            timestamps,
        })
    }

    pub fn from_path_with_ignore(
        directory: impl AsRef<Path>,
    ) -> Result<Self, DirectoryFromPathError> {
        crate::from_path_with_ignore::from_path_with_ignore::<Directory<'_>, DirEntry<'_>>(
            directory,
            |dir_path| {
                let meta = dir_path.metadata()?;
                let timestamps = Timestamps::from_metadata(&meta)?;

                Ok(Self {
                    children: BTreeMap::new(),
                    timestamps,
                })
            },
            DirEntry::Dir,
            |path| {
                let file = FileEntry::from_path(path)?;
                Ok(DirEntry::File(file))
            },
            |dir| &mut dir.children,
            |entry| match entry {
                DirEntry::Dir(d) => Some(d),
                DirEntry::File(_) => None,
            },
        )
    }
}

/// A single entry in a directory.
#[derive(Debug)]
pub enum DirEntry<'a> {
    /// A [`Directory`].
    Dir(Directory<'a>),
    /// A [`FileEntry`].
    File(FileEntry<'a>),
}

impl<'a> From<Directory<'a>> for DirEntry<'a> {
    fn from(value: Directory<'a>) -> Self {
        DirEntry::Dir(value)
    }
}

impl<'a, F> From<F> for DirEntry<'a>
where
    FileEntry<'a>: From<F>,
{
    fn from(value: F) -> Self {
        DirEntry::File(value.into())
    }
}

#[derive(Debug)]
pub struct FileEntry<'a> {
    timestamps: Timestamps,
    pub(crate) content: FileContent<'a>,
}

impl<'a> FileEntry<'a> {
    pub fn borrowed(bytes: &'a [u8], timestamps: Timestamps) -> FileEntry<'a> {
        FileEntry {
            timestamps,
            content: FileContent::Borrowed(bytes),
        }
    }

    pub fn owned(bytes: impl Into<Bytes>, timestamps: Timestamps) -> FileEntry<'a> {
        FileEntry {
            timestamps,
            content: FileContent::Owned(bytes.into()),
        }
    }

    pub fn reader(reader: Box<dyn Read>, timestamps: Timestamps) -> FileEntry<'a> {
        FileEntry {
            timestamps,
            content: FileContent::Reader(reader),
        }
    }

    /// Create a new [`FileEntry`] from a file on disk.
    ///
    /// To avoid having too many open file handles at a time, the file will only
    /// be opened on the first read.
    ///
    /// Beware of [time-of-check to time-of-use][toctou] issues. This function
    /// checks that the file exists when first called, but permissions may
    /// change or the file may still be deleted/moved/replaced before the first
    /// read.
    ///
    /// [toctou]: https://en.wikipedia.org/wiki/Time-of-check_to_time-of-use
    pub fn from_path(path: impl Into<PathBuf>) -> Result<Self, std::io::Error> {
        struct LazyReader {
            path: PathBuf,
            reader: Option<BufReader<File>>,
        }
        impl Read for LazyReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let r = match &mut self.reader {
                    Some(r) => r,
                    None => {
                        let f = File::open(&self.path)?;
                        self.reader.insert(BufReader::new(f))
                    }
                };

                r.read(buf)
            }
        }

        let path = path.into();
        let meta = path.metadata()?;

        let timestamps = Timestamps::from_metadata(&meta)?;
        let reader = Box::new(LazyReader { path, reader: None });

        Ok(FileEntry::reader(reader, timestamps))
    }
}

/// Some file-like object which can be written to a WEBC file.
pub(crate) enum FileContent<'a> {
    /// Bytes borrowed from somewhere else.
    Borrowed(&'a [u8]),
    /// Owned bytes.
    Owned(Bytes),
    /// A readable object.
    Reader(Box<dyn Read>),
}

impl<'a> fmt::Debug for FileContent<'a> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FileContent::Borrowed(b) => f
                .debug_tuple("Borrowed")
                .field(&readable_bytes::readable_bytes(b))
                .finish(),
            FileContent::Owned(b) => f
                .debug_tuple("Owned")
                .field(&readable_bytes::readable_bytes(b))
                .finish(),
            FileContent::Reader(_) => f.debug_tuple("Reader").finish(),
        }
    }
}

impl FileContent<'_> {
    fn write_to(self, mut writer: impl Write) -> Result<(), std::io::Error> {
        match self {
            FileContent::Borrowed(slice) => writer.write_all(slice),
            FileContent::Owned(bytes) => writer.write_all(&bytes),
            FileContent::Reader(mut reader) => {
                std::io::copy(&mut reader, &mut writer)?;
                Ok(())
            }
        }
    }
}

impl<'a> From<&'a [u8]> for FileEntry<'a> {
    fn from(value: &'a [u8]) -> Self {
        FileEntry::borrowed(value, Timestamps::default())
    }
}

impl<'a, const N: usize> From<&'a [u8; N]> for FileEntry<'a> {
    fn from(value: &'a [u8; N]) -> Self {
        FileEntry::borrowed(value, Timestamps::default())
    }
}

impl From<Vec<u8>> for FileEntry<'_> {
    fn from(value: Vec<u8>) -> Self {
        FileEntry::owned(value, Timestamps::default())
    }
}

impl<const N: usize> From<[u8; N]> for FileEntry<'_> {
    fn from(value: [u8; N]) -> Self {
        FileEntry::owned(value.to_vec(), Timestamps::default())
    }
}

impl From<Bytes> for FileEntry<'_> {
    fn from(value: Bytes) -> Self {
        FileEntry::owned(value, Timestamps::default())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use tempfile::tempdir;

    use crate::utils::{length_field, sha256};

    use super::*;

    #[test]
    fn from_path_with_ignore_ignores_hidden_and_git_related() {
        let root = tempdir().unwrap();

        let _hidden = std::fs::File::create(root.path().join(".hidden")).unwrap();

        let _git = std::fs::File::create(root.path().join(".git")).unwrap();

        let mut gitignore = std::fs::File::create(root.path().join(".gitignore")).unwrap();
        gitignore.write_all(b"ignore_me").unwrap();

        let mut wasmerignore = std::fs::File::create(root.path().join(".wasmerignore")).unwrap();
        wasmerignore.write_all(b"ignore_me_too").unwrap();

        std::fs::File::create(root.path().join("ignore_me")).unwrap();
        std::fs::File::create(root.path().join("ignore_me_too")).unwrap();

        std::fs::File::create(root.path().join("include_me")).unwrap();

        std::fs::create_dir(root.path().join("subdir")).unwrap();
        std::fs::File::create(root.path().join("subdir/ignore_me")).unwrap();
        std::fs::File::create(root.path().join("subdir/ignore_me_too")).unwrap();
        std::fs::File::create(root.path().join("subdir/include_me_too")).unwrap();

        std::fs::create_dir(root.path().join("subdir/othersub")).unwrap();
        std::fs::File::create(root.path().join("subdir/othersub/include_me_please")).unwrap();

        let dir = Directory::from_path_with_ignore(root.path()).unwrap();

        assert_eq!(dir.children.len(), 2);
        assert!(matches!(
            dir.children.get(&"include_me".try_into().unwrap()),
            Some(DirEntry::File(_))
        ));

        let subdir = match dir.children.get(&"subdir".try_into().unwrap()).unwrap() {
            DirEntry::Dir(d) => d,
            DirEntry::File(_) => panic!("Expected dir"),
        };
        assert_eq!(subdir.children.len(), 2);
        assert!(matches!(
            subdir.children.get(&"include_me_too".try_into().unwrap()),
            Some(DirEntry::File(_))
        ));

        let othersub = match subdir
            .children
            .get(&"othersub".try_into().unwrap())
            .unwrap()
        {
            DirEntry::Dir(d) => d,
            DirEntry::File(_) => panic!("Expected dir"),
        };
        assert_eq!(othersub.children.len(), 1);
        assert!(matches!(
            othersub
                .children
                .get(&"include_me_please".try_into().unwrap()),
            Some(DirEntry::File(_))
        ));
    }

    #[test]
    fn write_empty_volume() {
        let dir = Directory::default();

        let hash: [u8; 32] = sha2::Sha256::new().finalize().into();

        let VolumeParts { header, data } = VolumeParts::serialize(dir).unwrap();

        assert_bytes_eq!(
            header,
            bytes! {
                // ==== Header section ====
                // ---- root directory ----
                Tag::Directory,
                56_u64.to_le_bytes(),
                Timestamps::default(),
                hash,
            }
        );
        assert_bytes_eq!(
            data,
            bytes! {
                // ==== data section ====
                // (empty)
            }
        );
    }

    #[test]
    fn write_empty_volume_with_non_zero_timestamps() {
        let timestamps = Timestamps {
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000),
        };

        let hash: [u8; 32] = sha2::Sha256::new().finalize().into();

        let dir = Directory {
            children: BTreeMap::new(),
            timestamps,
        };

        let VolumeParts { header, data } = VolumeParts::serialize(dir).unwrap();

        assert_bytes_eq!(
            header,
            bytes! {
                // ==== Header section ====
                // ---- root directory ----
                Tag::Directory,
                56_u64.to_le_bytes(),

                // timestamps
                // accessed
                0_000_000_000_u64.to_le_bytes(),
                // modified
                2_000_000_000_u64.to_le_bytes(),
                // created
                0_000_000_000_u64.to_le_bytes(),

                hash,
            }
        );
        assert_bytes_eq!(
            data,
            bytes! {
                // ==== data section ====
                // (empty)
            }
        );
    }

    #[test]
    fn volume_with_single_file() {
        let file3_txt = b"Hello, World!";
        let timestamps = Timestamps {
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000),
        };
        let file_entry = FileEntry::borrowed(file3_txt.as_slice(), timestamps);

        let children = BTreeMap::from_iter(Some((
            "file3.txt".parse().unwrap(),
            DirEntry::from(file_entry),
        )));

        let dir = Directory {
            children,
            timestamps: Timestamps::default(),
        };

        let file_hash: [u8; 32] = sha2::Sha256::digest(file3_txt).into();
        let dir_hash: [u8; 32] = sha2::Sha256::digest(file_hash).into();

        let VolumeParts { header, data } = VolumeParts::serialize(dir).unwrap();

        assert_bytes_eq!(
            header,
            bytes! {
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
                timestamps,
            }
        );
        assert_bytes_eq!(data, file3_txt);
    }

    #[test]
    fn volume_that_just_contains_files() {
        let dir = dir_map! {
            "file1.txt" => b"first",
            "xyz.txt" => b"second",
            "file2.txt" => b"third",
        };

        let VolumeParts { header, data } = VolumeParts::serialize(dir).unwrap();

        let file1_hash: [u8; 32] = sha2::Sha256::digest(b"first").into();
        let xyz_hash: [u8; 32] = sha2::Sha256::digest(b"second").into();
        let file2_hash: [u8; 32] = sha2::Sha256::digest(b"third").into();

        let mut dir_hasher = sha2::Sha256::new();
        dir_hasher.update(file1_hash);
        dir_hasher.update(file2_hash);
        dir_hasher.update(xyz_hash);
        let dir_hash: [u8; 32] = dir_hasher.finalize().into();

        // Note: the initial order was "file1.txt", "xyz.txt", and "file2.txt",
        // but the BTreeMap implicitly sorted them
        assert_bytes_eq!(
            header,
            bytes! {
                // ---- Root directory ----
                Tag::Directory,
                225_u64.to_le_bytes(),
                // timestamps
                Timestamps::default(),
                // hash
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
            }
        );

        assert_bytes_eq!(data, b"firstthirdsecond");
    }

    #[test]
    fn header_with_single_directory() {
        let dir = dir_map! {
            "root" => dir_map!(),
        };

        let VolumeParts { header, .. } = VolumeParts::serialize(dir).unwrap();

        let empty_hash: [u8; 32] = sha2::Sha256::new().finalize().into();
        let dir_hash: [u8; 32] = sha2::Sha256::digest(empty_hash).into();

        let expected = bytes! {
            // ---- root directory ----
            Tag::Directory,
            108_u64.to_le_bytes(),
            // timestamps
            Timestamps::default(),
            // hash
            dir_hash,
            // first entry
            117_u64.to_le_bytes(),
            empty_hash,
            length_field("root"),
            "root",

            // ---- "/root" ----
            Tag::Directory,
            56_u64.to_le_bytes(),
            // timestamps
            Timestamps::default(),
            // hash
            empty_hash,

        };
        assert_bytes_eq!(header, expected);
    }

    #[test]
    fn volume_with_nested_empty_directories() {
        let dir = dir_map! {
            "root" => dir_map! {
                "nested" => dir_map! { },
            },
        };

        let VolumeParts { header, data } = VolumeParts::serialize(dir).unwrap();

        let empty_hash: [u8; 32] = sha2::Sha256::new().finalize().into();
        let root_hash: [u8; 32] = sha2::Sha256::digest(empty_hash).into();
        let dir_hash: [u8; 32] = sha2::Sha256::digest(root_hash).into();

        assert_bytes_eq!(
            header,
            bytes! {
                // ---- Root directory ----
                Tag::Directory,
                108_u64.to_le_bytes(),
                // timestamps
                Timestamps::default(),
                // hash
                dir_hash,
                // first entry
                117_u64.to_le_bytes(),
                root_hash,
                length_field("root"),
                "root",

                // ---- "/root" ----
                Tag::Directory,
                110_u64.to_le_bytes(),
                // timestamps
                Timestamps::default(),
                root_hash,
                // first entry
                236_u64.to_le_bytes(),
                empty_hash,
                length_field("nested"),
                "nested",

                // ---- "/root/nested" ----
                Tag::Directory,
                56_u64.to_le_bytes(),
                // timestamps
                Timestamps::default(),
                empty_hash,
            }
        );
        assert!(data.is_empty());
    }

    #[test]
    fn kitchen_sink() {
        let xyz_txt = [0xaa; 10];
        let file1_txt = [0xbb; 5];
        let file2_txt = [0xcc; 8];
        let file3_txt = [0xdd; 2];
        let dir = dir_map! {
            "a" => dir_map! {
                "b" => dir_map! {
                    "xyz.txt" => &xyz_txt,
                    "file1.txt" => &file1_txt,
                },
                "c" => dir_map! {
                    "d" => dir_map!(),
                    "file2.txt" => &file2_txt,
                },
            },
            "file3.txt" => &file3_txt,
        };

        let empty_hash: [u8; 32] = sha2::Sha256::new().finalize().into();

        let xyz_hash: [u8; 32] = sha2::Sha256::digest(xyz_txt).into();
        let file1_hash: [u8; 32] = sha2::Sha256::digest(file1_txt).into();
        let file2_hash: [u8; 32] = sha2::Sha256::digest(file2_txt).into();
        let file3_hash: [u8; 32] = sha2::Sha256::digest(file3_txt).into();

        let mut b_hasher = sha2::Sha256::new();
        b_hasher.update(file1_hash);
        b_hasher.update(xyz_hash);
        let b_hash: [u8; 32] = b_hasher.finalize().into();

        let mut c_hasher = sha2::Sha256::new();
        c_hasher.update(empty_hash);
        c_hasher.update(file2_hash);
        let c_hash: [u8; 32] = c_hasher.finalize().into();

        let mut a_hasher = sha2::Sha256::new();
        a_hasher.update(b_hash);
        a_hasher.update(c_hash);
        let a_hash: [u8; 32] = a_hasher.finalize().into();

        let mut dir_hasher = sha2::Sha256::new();
        dir_hasher.update(a_hash);
        dir_hasher.update(file3_hash);
        let dir_hash: [u8; 32] = dir_hasher.finalize().into();

        let VolumeParts { header, data } = VolumeParts::serialize(dir).unwrap();

        assert_bytes_eq!(
            header,
            bytes! {
                    // ---- Root directory ----
                    Tag::Directory,
                    162_u64.to_le_bytes(),
                    // timestamps
                    Timestamps::default(),
                    // hash
                    dir_hash,
                    // first entry
                    171_u64.to_le_bytes(),
                    a_hash,
                    length_field("a"),
                    "a",
                    // second entry
                    966_u64.to_le_bytes(),
                    file3_hash,
                    length_field("file3.txt"),
                    "file3.txt",

                    // ---- "/a" ----
                    Tag::Directory,
                    154_u64.to_le_bytes(),
                    // timestamps
                    Timestamps::default(),
                    // hash
                    a_hash,
                    // first entry
                    334_u64.to_le_bytes(),
                    b_hash,
                    length_field("b"),
                    "b",
                    // second entry
                    657_u64.to_le_bytes(),
                    c_hash,
                    length_field("c"),
                    "c",

                    // ---- "/a/b/" ----
                    Tag::Directory,
                    168_u64.to_le_bytes(),
                    // timestamps
                    Timestamps::default(),
                    // hash
                    b_hash,
                    // first entry
                    511_u64.to_le_bytes(),
                    file1_hash,
                    length_field("file1.txt"),
                    "file1.txt",
                    // second entry
                    584_u64.to_le_bytes(),
                    xyz_hash,
                    length_field("xyz.txt"),
                    "xyz.txt",

                    // ---- "/a/b/file1.txt" ----
                    Tag::File,
                    0_u64.to_le_bytes(),
                    5_u64.to_le_bytes(),
                    sha256(file1_txt),
                    // timestamps
                    Timestamps::default(),

                    // ---- "/a/b/xyz.txt" ----
                    Tag::File,
                    5_u64.to_le_bytes(),
                    15_u64.to_le_bytes(),
                    sha256(xyz_txt),
                    // timestamps
                    Timestamps::default(),

                    // ---- "/a/c/" ----
                    Tag::Directory,
                    162_u64.to_le_bytes(),
                    // timestamps
                    Timestamps::default(),
                    // hash
                    c_hash,
                    // First entry
                    828_u64.to_le_bytes(),
                    empty_hash,
                    length_field("d"),
                    "d",
                    // Second entry
                    893_u64.to_le_bytes(),
                    file2_hash,
                    length_field("file2.txt"),
                    "file2.txt",

                    // ---- "/a/c/d" ----
                    Tag::Directory,
                    56_u64.to_le_bytes(),
                    // timestamps
                    Timestamps::default(),
                    // hash
                    empty_hash,

                    // ---- "/a/c/file2.txt" ----
                    Tag::File,
                    15_u64.to_le_bytes(),
                    23_u64.to_le_bytes(),
                    sha256(file2_txt),
                    // timestamps
                    Timestamps::default(),

                    // ---- "file3.txt" ----
                    Tag::File,
                    23_u64.to_le_bytes(),
                    25_u64.to_le_bytes(),
                    sha256(file3_txt),
                    // timestamps
                    Timestamps::default(),
            }
        );
        assert_bytes_eq!(
            data,
            [file1_txt.as_slice(), &xyz_txt, &file2_txt, &file3_txt].concat()
        );
    }

    #[test]
    fn load_files_from_directory() {
        let temp = tempfile::tempdir().unwrap();
        let to = temp.path().join("path").join("to");
        let first = to.join("first.txt");
        let second = to.join("second.md");
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(first, "first".as_bytes()).unwrap();
        std::fs::write(second, "# Second".as_bytes()).unwrap();

        let dir = Directory::from_path(temp.path()).unwrap();

        let expected = dir_map! {
            "path" => dir_map! {
                "to" => dir_map! {
                    "first.txt" => b"first",
                    "second.md" => b"# Second",
                }
            }
        };

        assert_directories_match(dir, expected);
    }

    fn assert_directories_match(mut left: Directory<'_>, mut right: Directory<'_>) {
        let left_keys: Vec<_> = left.children.keys().cloned().collect();
        let right_keys: Vec<_> = right.children.keys().cloned().collect();
        assert_eq!(left_keys, right_keys);

        for key in &left_keys {
            match (
                left.children.remove(key).unwrap(),
                right.children.remove(key).unwrap(),
            ) {
                (DirEntry::Dir(left), DirEntry::Dir(right)) => {
                    assert_directories_match(left, right)
                }
                (DirEntry::File(left), DirEntry::File(right)) => {
                    assert_files_match(left, right, key)
                }
                (DirEntry::Dir(_), DirEntry::File(_)) | (DirEntry::File(_), DirEntry::Dir(_)) => {
                    panic!()
                }
            }
        }
    }

    fn assert_files_match(left: FileEntry<'_>, right: FileEntry<'_>, key: &str) {
        let mut left_buffer = Vec::new();
        left.content.write_to(&mut left_buffer).unwrap();
        let mut right_buffer = Vec::new();
        right.content.write_to(&mut right_buffer).unwrap();

        assert_bytes_eq!(
            left_buffer,
            right_buffer,
            "Entries for \"{key}\" don't match"
        );
    }
}
