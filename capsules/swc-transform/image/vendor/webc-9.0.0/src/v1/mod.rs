//! Parsing code for v1 of the WEBC format.

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    fmt,
    io::{Read, Seek},
    ops::Deref,
    path::{Component, Path, PathBuf},
    result,
};

use crate::indexmap::IndexMap;
use base64::{prelude::BASE64_STANDARD, Engine};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use shared_buffer::OwnedBuffer;
use url::Url;

#[cfg(feature = "crypto")]
use sequoia_openpgp::{
    parse::stream::{DetachedVerifierBuilder, MessageLayer, MessageStructure, VerificationHelper},
    Cert,
};

use crate::{
    metadata::{annotations::Emscripten, Manifest, UrlOrManifest},
    Version, MAGIC,
};

/// Container file, lazily parsed from a set of `&'data [u8]` bytes
#[derive(Debug, Clone, PartialEq)]
pub struct WebC<'data> {
    /// Version of the file format
    pub version: u64,
    /// Parsed checksum (optional in case of no encoded checksum)
    pub checksum: Option<Checksum>,
    /// Parsed signature (optional if file was not signed)
    pub signature: Option<Signature>,
    /// Manifest of the file, see section `§2.3.1` of the spec
    pub manifest: Manifest,
    /// Executable files, indexed into one volume (`a.wasm` => `a`, `b.wasm` => `b@0.2.1`)
    pub atoms: Volume<'data>,
    /// Filesystem volumes: default volume name is `atom` (containing files of the current package)
    /// and `user/package@version` for external dependencies. Every dependency can be sandboxed to only
    /// access its own filesystem volume, not external ones.
    pub volumes: IndexMap<String, Volume<'data>>,
}

/// Memory-mapped version of the WebC file that
/// carries its data along the parsed `WebC<'static>`
#[derive(Debug, Clone)]
pub struct WebCMmap {
    pub webc_hash: [u8; 32],
    /// WebC file, referencing the memory-mapped backed data
    pub webc: WebC<'static>,
    /// Note: The `webc` field has references into this shared state, so make
    /// sure we don't drop it prematurely.
    #[allow(dead_code)]
    pub(crate) buffer: OwnedBuffer,
}

impl Deref for WebCMmap {
    type Target = WebC<'static>;
    fn deref(&self) -> &Self::Target {
        &self.webc
    }
}

impl WebCMmap {
    /// Same as `WebC::parse`, but uses a memory-mapped file
    pub fn parse(path: impl AsRef<Path>, options: &ParseOptions) -> ReadResult<Self> {
        let path = path.as_ref();

        std::fs::File::open(path)
            .map_err(|e| Error(e.to_string()))
            .and_then(|f| WebCMmap::from_file(f, options))
            .map_err(|e| Error(format!("Could not open {}: {e}", path.display())))
    }

    pub fn from_file(mut file: std::fs::File, options: &ParseOptions) -> ReadResult<Self> {
        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .map_err(|e| Error(format!("Failed to read file: {e}")))?;
        file.seek(std::io::SeekFrom::Start(0))
            .map_err(|e| Error(format!("File to seek to the start of the file: {e}")))?;

        let webc_hash: [u8; 32] = sha2::Sha256::digest(data.as_slice()).into();

        let buffer = OwnedBuffer::from_file(&file).map_err(|e| Error(e.to_string()))?;

        let webc = WebC::parse(&buffer, options)?;
        // Safety: transmute the lifetime away. This is unsound. See the
        // comments in WebcOwned::parse() for more.
        let webc: WebC<'static> = unsafe { std::mem::transmute(webc) };

        Ok(Self {
            webc_hash,
            webc,
            buffer,
        })
    }

    pub fn webc_hash(&self) -> Option<[u8; 32]> {
        Some(self.webc_hash)
    }

    pub fn as_webc_ref(&self) -> WebC<'_> {
        self.webc.clone()
    }
}

/// Owned version of the WebC file that carries its data
/// along the parsed `WebC<'static>`
#[derive(Debug, Clone)]
pub struct WebCOwned {
    webc_hash: [u8; 32],
    pub webc: WebC<'static>,
    #[allow(dead_code)]
    pub(crate) backing_data: Bytes,
}

impl WebCOwned {
    /// Same as `WebC::parse`, but keeps the resulting `data` in memory,
    /// instead of referencing it
    pub fn parse(data: impl Into<Bytes>, options: &ParseOptions) -> ReadResult<Self> {
        let data: Bytes = data.into();

        let webc_hash: [u8; 32] = sha2::Sha256::digest(&data).into();

        let webc = WebC::parse(&data, options)?;
        // Safety: We're transmuting the lifetime away here because WebCOwned is
        // technically a self-referential struct.
        // This is unsound because we implement Deref and make the field public
        // and it is possible to get a reference to something inside the WebC,
        // drop this WebCOwned, then trigger a use-after-free bug... but, fixing
        // it would require reworking a bunch of downstream code and that's not
        // possible at the moment.
        let webc: WebC<'static> = unsafe { std::mem::transmute(webc) };
        Ok(Self {
            webc_hash,
            webc,
            backing_data: data,
        })
    }

    pub fn webc_hash(&self) -> Option<[u8; 32]> {
        Some(self.webc_hash)
    }

    pub fn as_webc_ref(&self) -> WebC<'_> {
        self.webc.clone()
    }
}

impl Deref for WebCOwned {
    type Target = WebC<'static>;
    fn deref(&self) -> &Self::Target {
        &self.webc
    }
}

/// The error type used within the read module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.as_str())
    }
}

impl std::error::Error for Error {}

/// The result type used within the read module.
pub type ReadResult<T> = result::Result<T, Error>;

/// Calculated checksum of the file
#[derive(Clone, PartialEq, Eq)]
pub struct Checksum {
    /// (crate-internal): how many bytes of the signature
    /// are valid, how many are padding
    pub valid_until: usize,
    /// Type of checksum (16 bytes long, `------------`, `sha256----------`, etc.)
    pub chk_type: String,
    /// Data of the checksum bytes, 256 bytes long
    pub data: Vec<u8>,
    /// Whether the checksum has been validated during `WebC::parse`
    pub valid: bool,
}

#[derive(Serialize)]
struct DisplayableChecksum {
    valid: bool,
    chk_type: String,
    data: String,
}

impl fmt::Debug for DisplayableChecksum {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let json = serde_json::to_string_pretty(self).unwrap_or_default();
        write!(f, "{json}")
    }
}

impl fmt::Debug for Checksum {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut clone = self.clone();
        clone.data.truncate(self.valid_until);
        let base64 = BASE64_STANDARD.encode(&clone.data);
        let displayable = DisplayableChecksum {
            valid: self.valid,
            chk_type: self.chk_type.clone(),
            data: base64,
        };
        displayable.fmt(f)
    }
}

/// Signature of the checksum of the file, such that
/// `verify(WebC::get_checksum(), public_key)` is valid
#[derive(Clone, PartialEq, Eq)]
pub struct Signature {
    /// (crate-internal): how many bytes of the signature
    /// are valid, how many are padding
    pub valid_until: usize,
    /// Data of the signature
    pub data: Vec<u8>,
    /// Whether the signature has been checked to be valid
    /// during parsing
    pub valid: bool,
}

#[derive(Serialize)]
struct DisplayableSignature {
    valid: bool,
    data: String,
}

impl fmt::Debug for DisplayableSignature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let json = serde_json::to_string_pretty(self).unwrap_or_default();
        write!(f, "{json}")
    }
}

impl fmt::Debug for Signature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut clone = self.clone();
        clone.data.truncate(self.valid_until);
        let base64 = BASE64_STANDARD.encode(&clone.data);
        let displayable = DisplayableSignature {
            valid: self.valid,
            data: base64,
        };
        displayable.fmt(f)
    }
}

/// Filesystem volume, containing the uncompressed files in an ordered directory structure
#[derive(Default, Clone, PartialEq, Eq)]
pub struct Volume<'data> {
    /// Header, storing all the offsets and file names in order
    pub header: VolumeHeader<'data>,
    /// Volume filesystem
    pub data: &'data [u8],
}

impl<'data> fmt::Debug for Volume<'data> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.header.fmt(f)?;
        write!(f, "\r\ndata: [ ... ({} bytes) ]", self.data.len())
    }
}

/// Specifies whether an input path is a directory or a file
/// (since this distinction can't be made from the filename alone)
#[derive(Clone, Debug, PartialEq, PartialOrd, Ord, Eq, Hash)]
pub enum DirOrFile {
    Dir(PathBuf),
    File(PathBuf),
}

impl fmt::Display for DirOrFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.get_path_buf().display())
    }
}

impl DirOrFile {
    /// Returns the `PathBuf` of the `DirOrFile`
    pub fn get_path_buf(&self) -> &PathBuf {
        match &self {
            DirOrFile::Dir(d) | DirOrFile::File(d) => d,
        }
    }

    /// Returns all the "Normal" components of the PathBuf, note that
    /// non-normal (such as ".", symlinks, etc. components) are ignored
    pub fn components(&self) -> Vec<String> {
        self.get_path_buf()
            .components()
            .filter_map(|c| match c {
                Component::Normal(c) => Some(c.to_str()?.to_string()),
                _ => None,
            })
            .collect()
    }

    /// Returns whether the `FileOrDir` is a directory
    #[must_use]
    pub fn is_dir(&self) -> bool {
        match self {
            DirOrFile::Dir(_) => true,
            DirOrFile::File(_) => false,
        }
    }
}

impl<'a> Volume<'a> {
    /// Serialize an atom volume.
    ///
    /// This is essentially [`Volume::serialize_files()`], but it will modify
    /// the input files to uphold several atom-specific invariants - namely
    /// that each atom is addressable by its module name. This means:
    ///
    /// - All atoms are hoisted to the top level folder
    /// - Extensions are removed from filenames
    pub fn serialize_atoms(files: BTreeMap<DirOrFile, Vec<u8>>) -> Vec<u8> {
        let mut rewritten_files = BTreeMap::new();

        for (entry, data) in files {
            // Note: we want to ignore all directories, and strip the dirname
            // and extension from any files.
            if let DirOrFile::File(path) = entry {
                if let Some(filename) = path.file_name() {
                    rewritten_files.insert(DirOrFile::File(filename.into()), data);
                }
            }
        }

        Volume::serialize_files(rewritten_files)
    }

    /// Create a volume from a set of initial files
    pub fn serialize_files(files: BTreeMap<DirOrFile, Vec<u8>>) -> Vec<u8> {
        // Input:
        //
        // /a/c/file.txt: [... text file with 10000 bytes ...], false
        // /b:            [], true (empty directory)

        // strip the "/" prefix from all paths
        let files = files
            .into_iter()
            .map(|(path, file)| {
                let new_path = match path.get_path_buf().strip_prefix("/") {
                    Ok(o) => o.to_path_buf(),
                    Err(_) => path.get_path_buf().clone(),
                };

                (new_path, (file, path.is_dir()))
            })
            .collect::<BTreeMap<_, _>>();

        let mut volume_content = Vec::new();
        let mut file_path_offsets = BTreeMap::new();

        // all files including parent directories
        //
        // [/, /a, /b, /a/c, /a/c/file.txt]
        let mut all_files = BTreeMap::new();
        for (path, (_, is_dir)) in files.iter() {
            all_files.insert(path.clone(), *is_dir);

            let mut components = path
                .components()
                .filter_map(|r| match r {
                    std::path::Component::Normal(n) => Some(n.to_str().unwrap_or("").to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>();

            if !is_dir {
                components.pop();
            }

            while !components.is_empty() {
                let parent_path = components.clone().join("/");
                let path = Path::new(&parent_path).to_path_buf();
                all_files.insert(path, true);
                components.pop();
            }
        }

        for (path, (mut file, is_dir)) in files.into_iter() {
            if !is_dir {
                // path is a file
                let cursor = volume_content.len();
                let file_len = file.len();
                volume_content.append(&mut file);
                file_path_offsets.insert(path.clone(), (cursor, cursor + file_len));
            }
        }

        // 0: ["/"]
        // 1: ["/a", "/b", "/c"]
        // 2: ["/a/c"]
        // 3: ["/a/c/file.txt"]
        let mut files_grouped_by_level = BTreeMap::new();
        for (path, is_dir) in all_files.iter() {
            let num_parents = path.ancestors().count().saturating_sub(2);
            files_grouped_by_level
                .entry(num_parents)
                .or_insert_with(Vec::new)
                .push((path.clone(), *is_dir));
        }

        // For every level: get how many items in the next directory
        // start with the current path. Pre-sort the files in the subdirectory
        //
        // 1: [("a", ["a/c"]), ("b", [])]
        // 2: [("a/c", ["a/c/file.txt"])]
        // 3: [("a/c/file.txt", [])]
        let mut directories_by_level_with_entrycount = BTreeMap::new();
        for (level, paths) in files_grouped_by_level.iter() {
            for (path, is_dir) in paths {
                let mut files_in_directory =
                    if files_grouped_by_level.get(&(level + 1)).is_none() || !is_dir {
                        Vec::new()
                    } else {
                        files_grouped_by_level[&(level + 1)]
                            .iter()
                            .filter(|(next_level_entry, _next_level_is_dir)| {
                                next_level_entry.starts_with(path)
                            })
                            .cloned()
                            .collect()
                    };

                files_in_directory.sort();

                directories_by_level_with_entrycount
                    .entry(level)
                    .or_insert_with(Vec::new)
                    .push(((path.clone(), is_dir), files_in_directory));
            }
        }

        // Now sort the directories levels internally
        //
        // 1: [("a", ["a/c"]), ("b", [])]
        // 2: [("a/c", ["a/c/file.txt"])]
        // 3: [("a/c/file.txt", [])]
        for (_, paths) in directories_by_level_with_entrycount.iter_mut() {
            paths.sort_by(|a, b| a.0.cmp(&b.0));
        }

        // Calculate offsets for the subdirectories
        //
        // - full file / directory name
        // - file / directory name relative to parent
        // - for each file in subdirectory:
        //     - full file / directory name
        //     - file / directory name relative to subdir
        // - total size of subdirectory in bytes
        //
        // 1: (50 bytes directory level size = (2 * 24 bytes + 2 bytes for directory names), [
        //    ("a", "a", 25),
        //    ("b", "b", 0)
        // ])
        // 2: (25 bytes directory level size = (1 * 24 bytes + 1 byte for directory name), [
        //    ("a/c", "c", 32),
        // ])
        // 3: (32 bytes directory level size = (1 * 24 bytes + 8 bytes for the file name), [
        //    ("a/c/file.txt", "file.txt", 0)
        // ])
        let mut byte_size_of_each_level: BTreeMap<usize, _> = BTreeMap::new();

        for (level, entries) in directories_by_level_with_entrycount.iter() {
            let mut byte_size_of_level = entries
                .iter()
                .map(|((e, _), _)| get_parent(e))
                .collect::<BTreeSet<_>>()
                .len()
                * 8;

            let mut entries_subdir: Vec<(&PathBuf, String, usize)> = Vec::new();

            for ((entry_name, _is_dir), subdir) in entries.iter() {
                let entry_name_last_component = match get_last_component(entry_name) {
                    Some(s) => s.to_string(),
                    None => continue,
                };

                byte_size_of_level += entry_name_last_component.as_bytes().len() + 24;

                let mut subdir_size = subdir
                    .iter()
                    .map(|(e, _)| get_parent(e))
                    .collect::<BTreeSet<_>>()
                    .len()
                    * 8;

                for (sub, _sub_is_dir) in subdir.iter() {
                    // /a/c/file.txt => "file.txt"
                    let subdir_last_component = match get_last_component(sub) {
                        Some(s) => s.to_string(),
                        None => continue,
                    };
                    subdir_size += subdir_last_component.as_bytes().len() + 24;
                }

                entries_subdir.push((entry_name, entry_name_last_component, subdir_size));
            }

            byte_size_of_each_level.insert(**level, (byte_size_of_level, entries_subdir));
        }

        // Now construct the directory level [FileEntry] bytes and encode them
        //
        // [
        //    [FsEntry::Dir, "a", start: (8 + 50), end: (8 + 50) + (8 + 25)]
        //    [FsEntry::Dir, "b", start: (8 + 50) + (8 + 25), end: (8 + 50) + (8 + 25)] (= empty directory)
        // ],
        // [
        //    [FsEntry::Dir, "c", start: (8 + 50) + (8 + 25), end: (8 + 50) + (8 + 25) + (8 + 32)]
        // ],
        // [
        //    [Fs::Entry::File, "file.txt", start: 0, end: 10000 ]
        // ]
        let mut levels = Vec::new();
        let mut cursor = 0;
        for (_, (dir_level_bytes, dir_level)) in byte_size_of_each_level.iter() {
            // calculate at which byte offset in the header the next directory level will start
            // 8 bytes reserved for directory level size
            let next_level_start = cursor + dir_level_bytes;

            let mut cur_level = Vec::new();
            let mut next_dir_level_cursor = 0;

            for (full_name, dir_or_file_name, subdir_len_bytes) in dir_level.iter() {
                match file_path_offsets.get(&**full_name) {
                    Some((start, end)) => {
                        // path is a file, nothing to do
                        cur_level.push((
                            full_name,
                            HeaderEntry {
                                flags: Flags::File,
                                text: dir_or_file_name.parse().unwrap(),
                                offset_start: (*start as u64),
                                offset_end: (*end as u64),
                            },
                        ));
                    }
                    None => {
                        // path is a directory that potentially has subdirectories
                        cur_level.push((
                            full_name,
                            HeaderEntry {
                                flags: Flags::Dir,
                                text: dir_or_file_name.parse().unwrap(),
                                offset_start: next_level_start as u64 + next_dir_level_cursor,
                                offset_end: next_level_start as u64
                                    + next_dir_level_cursor
                                    + (*subdir_len_bytes as u64),
                            },
                        ));
                        next_dir_level_cursor += *subdir_len_bytes as u64;
                    }
                }
            }

            levels.push(cur_level);
            cursor = next_level_start;
        }

        let mut header = Vec::new();

        for fs_entries in levels.iter() {
            let mut current_level = Vec::new();

            let (mut current_dir, mut entries) = match fs_entries.first() {
                Some((full_name, e)) => (get_parent(full_name), vec![e.clone()]),
                None => continue,
            };

            for (full_name, entry) in fs_entries.iter().skip(1) {
                let parent_of_current_entry = get_parent(full_name);

                // each time the `current_dir` changes (for example from "/a/b/c" to "/a/b/d",
                // we have to start a new directory section)
                if parent_of_current_entry != current_dir {
                    let mut buffer = Vec::new();
                    for entry in entries.drain(..) {
                        entry.write_to(&mut buffer);
                    }
                    current_level.extend(u64::try_from(buffer.len()).unwrap().to_le_bytes());
                    current_level.extend(buffer);
                    current_dir = parent_of_current_entry;
                }
                entries.push(entry.clone());
            }

            if !entries.is_empty() {
                let mut buffer = Vec::new();
                for entry in entries.drain(..) {
                    entry.write_to(&mut buffer);
                }
                current_level.extend(u64::try_from(buffer.len()).unwrap().to_le_bytes());
                current_level.extend(buffer);
            }

            header.extend(current_level);
        }

        let mut total = to_leb(header.len() as u64);
        total.extend_from_slice(&header);
        total.append(&mut volume_content);

        total
    }

    /// Returns all files and directories with the corresponding `FsEntry`
    pub fn get_all_file_and_dir_entries(
        &'a self,
    ) -> Result<BTreeMap<DirOrFile, FsEntry<'a>>, Error> {
        let mut target = BTreeMap::new();
        let mut levels = vec![(PathBuf::new(), self.header.top_level.clone())];

        while !levels.is_empty() {
            let mut next_levels = Vec::new();

            for (parent_path, entries) in levels.iter() {
                for entry in entries {
                    let real_path = parent_path.clone().join(&*entry.text);
                    let offset_start: usize =
                        entry.offset_start.try_into().unwrap_or(u32::MAX as usize);
                    let offset_end: usize =
                        entry.offset_end.try_into().unwrap_or(u32::MAX as usize);

                    match entry.fs_type {
                        FsEntryType::File => {
                            target.insert(DirOrFile::File(real_path.clone()), entry.clone());
                        }
                        FsEntryType::Dir => {
                            let next_level_entries =
                                FsEntry::parse(&self.header.header_data[offset_start..offset_end]);
                            target.insert(DirOrFile::Dir(real_path.clone()), entry.clone());
                            next_levels.push((real_path.clone(), next_level_entries));
                        }
                    }
                }
            }

            levels = next_levels;
        }

        Ok(target)
    }

    /// Returns all entries in a "tree" sorted structure, i.e.
    /// sorted in the same way you'd see the files in a tree explorer
    pub fn get_all_file_entries_recursivesorted(&'a self) -> RecursiveFsEntryDir<'a> {
        let mut target = RecursiveFsEntryDir {
            name: "/".to_string(),
            contents: Vec::new(),
        };
        let dir_entries = Self::specialsort_dir(&self.header.top_level[..]);
        append_entries_recursive(self.header.header_data, dir_entries, &mut target);
        target
    }

    /// Returns all entries in a "tree" sorted structure, i.e.
    /// sorted in the same way you'd see the files in a tree explorer
    pub fn get_all_file_entries_directorysorted(&'a self) -> Vec<(DirOrFile, FsEntry<'a>)> {
        let mut target = Vec::new();

        Self::specialsort_append_to_target(
            PathBuf::new(),
            &self.header.top_level,
            self.header.header_data,
            &mut target,
        );

        target
    }

    fn specialsort_append_to_target(
        parent_path: PathBuf,
        entries: &[FsEntry<'a>],
        data: &'a [u8],
        target: &mut Vec<(DirOrFile, FsEntry<'a>)>,
    ) {
        let dir_entries = entries
            .iter()
            .filter(|f| f.fs_type == FsEntryType::Dir)
            .cloned()
            .collect::<Vec<_>>();
        let dir_entries = Self::specialsort_dir(&dir_entries);
        for entry in dir_entries {
            target.push((
                DirOrFile::Dir(parent_path.join(entry.text.as_ref())),
                entry.clone(),
            ));
            let offset_start: usize = entry.offset_start.try_into().unwrap_or(u32::MAX as usize);
            let offset_end: usize = entry.offset_end.try_into().unwrap_or(u32::MAX as usize);
            let fs_entry_bytes = match get_byte_slice(data, offset_start, offset_end) {
                Some(s) => s,
                None => {
                    println!("cannot get byte slice");
                    continue;
                }
            };
            let dir_entries = FsEntry::parse(fs_entry_bytes);
            Self::specialsort_append_to_target(
                parent_path.join(entry.text.as_ref()),
                &dir_entries,
                data,
                target,
            );
        }

        let file_entries = entries
            .iter()
            .filter(|f| f.fs_type == FsEntryType::File)
            .cloned()
            .collect::<Vec<_>>();
        let file_entries = Self::specialsort_dir(&file_entries);

        for entry in file_entries {
            target.push((
                DirOrFile::File(parent_path.join(entry.text.as_ref())),
                entry.clone(),
            ));
        }
    }

    fn specialsort_dir(entries: &[FsEntry<'a>]) -> Vec<FsEntry<'a>> {
        use lexical_sort::lexical_cmp;

        let mut dirs = entries
            .iter()
            .filter(|e| e.fs_type == FsEntryType::Dir)
            .cloned()
            .collect::<Vec<_>>();
        dirs.sort_by(|a, b| lexical_cmp(a.text.as_ref(), b.text.as_ref()));

        let mut files = entries
            .iter()
            .filter(|e| e.fs_type == FsEntryType::File)
            .cloned()
            .collect::<Vec<_>>();
        files.sort_by(|a, b| lexical_cmp(a.text.as_ref(), b.text.as_ref()));

        dirs.append(&mut files);
        dirs
    }

    /// Generic walk function that walks recursively over the files and
    /// calls a callback function with `self.data` on every entry.
    pub fn walk<'b>(&'b self) -> VolumeIterator<'a, 'b> {
        let parent = PathBuf::new();
        VolumeIterator {
            volume: self,
            entries: Self::specialsort_dir(&self.header.top_level)
                .iter()
                .map(|v| match v.fs_type {
                    FsEntryType::File => DirOrFile::File(parent.join(v.text.as_ref())),
                    FsEntryType::Dir => DirOrFile::Dir(parent.join(v.text.as_ref())),
                })
                .collect(),
        }
    }

    /// Returns all the files in this volume, indexed by the full path
    /// (in unix fashion, i.e. "/", "/a", "/b/file.txt")
    pub fn get_all_files_and_directories_with_bytes(
        &self,
    ) -> Result<BTreeSet<DirOrFileWithBytes<'_>>, Error> {
        self.get_all_file_and_dir_entries()?
            .into_iter()
            .map(|(path, entry)| {
                if entry.fs_type == FsEntryType::File {
                    let offset_start: usize = entry
                        .offset_start
                        .try_into()
                        .map_err(|e| Error(format!("{e}: {path}")))?;
                    let offset_end: usize = entry
                        .offset_end
                        .try_into()
                        .map_err(|e| Error(format!("{e}: {path}")))?;
                    let data = self.data.get(offset_start..offset_end).ok_or_else(|| {
                        Error(format!(
                            "could not get data {offset_start}..{offset_end}: {path}"
                        ))
                    })?;
                    Ok(DirOrFileWithBytes::File {
                        path: path.get_path_buf().clone(),
                        bytes: data,
                    })
                } else {
                    Ok(DirOrFileWithBytes::Dir {
                        path: path.get_path_buf().clone(),
                    })
                }
            })
            .collect()
    }

    /// Returns the number of files in this volume
    pub fn count_files(&self) -> u64 {
        let mut cursor = 0;
        let mut num_files = 0;
        while cursor < self.header.header_data.len() {
            let next_directory_level = FsEntry::parse(&self.header.header_data[cursor..]);
            num_files += next_directory_level
                .iter()
                .filter(|f| f.fs_type == FsEntryType::File)
                .count() as u64;
            cursor += FsEntry::calculate_byte_length(&next_directory_level);
        }
        num_files
    }

    /// Returns the number of directories in this volume
    pub fn count_directories(&self) -> u64 {
        let mut cursor = 0;
        let mut num_files = 0;
        while cursor < self.header.header_data.len() {
            let next_directory_level = FsEntry::parse(&self.header.header_data[cursor..]);
            num_files += next_directory_level
                .iter()
                .filter(|f| f.fs_type == FsEntryType::Dir)
                .count() as u64;
            cursor += FsEntry::calculate_byte_length(&next_directory_level);
        }
        num_files
    }

    pub fn list_directories(&self) -> Vec<String> {
        self.get_all_file_and_dir_entries()
            .unwrap_or_default()
            .iter()
            .filter_map(|(path, _)| match path {
                DirOrFile::Dir(d) => Some(format!("{}", d.display())),
                DirOrFile::File(_) => None,
            })
            .collect()
    }

    /// Parses a filesystem volume from a buffer of bytes
    pub fn parse(data: &'a [u8]) -> Result<Self, Error> {
        let leb_size = get_leb_size(data).ok_or(Error(
            "Error parsing volume: could not read header size LEB128".to_string(),
        ))?;

        if data.len() < leb_size {
            return Err(Error(format!(
                "Error parsing volume: expected at least {leb_size} bytes, got {}",
                data.len()
            )));
        }

        let header_len: usize = from_leb(data)
            .ok_or(Error(format!(
                "Could not read header length from data (first {leb_size} bytes)"
            )))?
            .try_into()
            .unwrap_or(usize::MAX);

        if data.len() < header_len + leb_size {
            return Err(Error(format!(
                "Error parsing volume: expected at least {} bytes, got only {}",
                header_len + leb_size,
                data.len()
            )));
        }

        let (header, data) = data[leb_size..].split_at(header_len);

        let header = VolumeHeader::from_slice(header);

        Ok(Self { header, data })
    }

    /// Returns file entries for `$path`
    pub fn read_dir(&self, path: &str) -> Result<Vec<FsEntry<'a>>, Error> {
        // removes redundant ".", "..", etc
        let clean = path_clean::clean(path);

        let mut components = Path::new(&clean)
            .components()
            .filter_map(|s| match s {
                Component::Normal(s) => s.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>();

        components.reverse();

        let mut directory_to_search = self.header.top_level.clone();

        while let Some(searched_directory_name) = components.pop() {
            let found = match directory_to_search
                .binary_search_by(|probe| (*probe.text).cmp(searched_directory_name))
            {
                Ok(i) => directory_to_search[i].clone(),
                Err(_) => {
                    return Err(Error(format!("Could not find directory {clean:?}: could not find  directory {searched_directory_name:?} (os error 2)")));
                }
            };

            let offset_start: usize = found.offset_start.try_into().unwrap_or(u32::MAX as usize);
            let offset_end: usize = found.offset_end.try_into().unwrap_or(u32::MAX as usize);

            match found.fs_type {
                FsEntryType::File => {
                    return Err(Error(format!(
                        "Could not find directory {clean:?} (os error 2)"
                    )));
                }
                FsEntryType::Dir => {
                    if offset_start == offset_end {
                        directory_to_search = Vec::new();
                    } else {
                        let next_dir_level_to_decode = get_byte_slice(self.header.header_data, offset_start, offset_end)
                        .ok_or(Error(format!("Could not find directory {clean:?}: could not decode directory {searched_directory_name:?} at byte offset {offset_start}..{offset_end} (os error -2)")))?;

                        directory_to_search = FsEntry::parse(next_dir_level_to_decode);
                    }
                }
            }
        }

        Ok(directory_to_search)
    }

    /// Returns the file entry for `$path`. Note that this does not
    /// return the file contents directly, use `volume.get_file(path)` instead.
    ///
    /// # Errors
    ///
    /// Returns an error if the file is a directory.
    pub fn get_file_entry(&self, path: &str) -> Result<OwnedFsEntryFile, Error> {
        let clean = path_clean::clean(path); // removes redundant ".", "..", etc

        let mut components = Path::new(&clean)
            .components()
            .filter_map(|s| match s {
                Component::Normal(s) => s.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>();

        components.reverse();

        let mut directory_to_search = self.header.top_level.clone();

        while let Some(searched_directory_name) = components.pop() {
            let found = match directory_to_search
                .binary_search_by(|probe| (*probe.text).cmp(searched_directory_name))
            {
                Ok(i) => directory_to_search[i].clone(),
                Err(_) => {
                    return Err(Error(format!("Could not find file {clean:?}: could not find file or directory {searched_directory_name:?} (os error 2)")));
                }
            };

            let offset_start: usize = found.offset_start.try_into().unwrap_or(u32::MAX as usize);
            let offset_end: usize = found.offset_end.try_into().unwrap_or(u32::MAX as usize);

            match found.fs_type {
                FsEntryType::File => {
                    if !components.is_empty() {
                        return Err(Error(format!("Could not find file {clean:?} (os error 2)")));
                    }

                    return Ok(OwnedFsEntryFile {
                        text: path.to_string(),
                        offset_start: offset_start as u64,
                        offset_end: offset_end as u64,
                    });
                }
                FsEntryType::Dir => {
                    if offset_start == offset_end {
                        directory_to_search = Vec::new();
                    } else {
                        let next_dir_level_to_decode = get_byte_slice(self.header.header_data, offset_start, offset_end)
                        .ok_or(Error(format!("Could not find file {clean:?}: could not decode directory {searched_directory_name:?} at byte offset {offset_start}..{offset_end} (os error -2)")))?;

                        directory_to_search = FsEntry::parse(next_dir_level_to_decode);
                    }
                }
            }
        }

        Err(Error(format!("Could not find file {clean:?} (os error 2)")))
    }

    /// Given an already-existing `OwnedFsEntryFile`, returns the byte slice for this
    /// file entry.
    ///
    /// # Errors
    ///
    /// The function returns an error if the file entry is out of bounds of the
    /// underlying data slice (should never happen)
    pub fn get_file_bytes(&self, entry: &OwnedFsEntryFile) -> Result<&'a [u8], Error> {
        static EMPTY_SLICE: &[u8] = &[];

        let offset_start = entry.offset_start.try_into().unwrap_or(u32::MAX as usize);
        let offset_end = entry.offset_end.try_into().unwrap_or(u32::MAX as usize);

        // empty file
        if offset_start == offset_end {
            return Ok(EMPTY_SLICE);
        }

        get_byte_slice(self.data, offset_start, offset_end).ok_or(Error(format!(
            "Could not file file {:?} - filesystem corrupt at {}..{} (os error -1)",
            entry.text, entry.offset_start, entry.offset_end
        )))
    }

    /// Returns the file contents (shorthand for
    /// `volume.get_file_bytes(volume.get_file_entry(path))`)
    pub fn get_file(&'a self, path: &str) -> Result<&'a [u8], Error> {
        let owned_file_entry = self.get_file_entry(path)?;
        self.get_file_bytes(&owned_file_entry)
    }

    /// Serializes the volume into writable bytes (including
    /// the header and header length)
    pub fn into_bytes(&self) -> Vec<u8> {
        // TODO(felix): avoid extra allocation?
        let mut out = Vec::new();
        out.extend_from_slice(&to_leb(self.header.header_data.len() as u64));
        out.extend_from_slice(self.header.header_data);
        out.extend_from_slice(self.data);
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HeaderEntry {
    flags: Flags,
    offset_start: u64,
    offset_end: u64,
    text: String,
}

impl HeaderEntry {
    fn write_to(&self, buffer: &mut Vec<u8>) {
        // Note: The reference implementation diverges from the spec
        // here - the flag should actually go first.
        buffer.extend(self.text_length());
        buffer.extend(self.flags.as_bytes());

        buffer.extend(self.offset_start.to_le_bytes());
        buffer.extend(self.offset_end.to_le_bytes());
        buffer.extend(self.text.as_bytes());
    }

    fn text_length(&self) -> [u8; 7] {
        text_length(&self.text)
    }
}

fn text_length(text: &str) -> [u8; 7] {
    let length = u64::try_from(text.len()).unwrap();
    let [head @ .., last] = length.to_le_bytes();
    assert_eq!(
        last,
        0,
        "Text length of {} is out of bounds (max = 2^56 = 72,057,594,037,927,936) for text {:?}",
        text.len(),
        &text[..250],
    );
    head
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Flags {
    Dir = 0b00,
    File = 0b01,
}

impl Flags {
    pub(crate) fn as_bytes(self) -> [u8; 1] {
        [self as u8]
    }
}

/// Iterator over the paths in the file, yields PathBufs
/// until all files in the volume have been listed.
#[derive(Debug)]
pub struct VolumeIterator<'b, 'a: 'b> {
    pub volume: &'b Volume<'a>,
    pub entries: Vec<DirOrFile>,
}

impl<'a, 'b> Iterator for VolumeIterator<'a, 'b> {
    type Item = DirOrFile;

    fn next(&mut self) -> Option<Self::Item> {
        let next = self.entries.pop();

        if let Some(DirOrFile::Dir(d)) = next.as_ref() {
            self.entries.extend(
                Volume::specialsort_dir(
                    &self
                        .volume
                        .read_dir(&format!("/{}", d.display()))
                        .unwrap_or_default(),
                )
                .iter()
                .map(|v| match v.fs_type {
                    FsEntryType::File => DirOrFile::File(d.join(v.text.as_ref())),
                    FsEntryType::Dir => DirOrFile::Dir(d.join(v.text.as_ref())),
                }),
            );
        }

        next
    }
}

#[derive(Debug, Clone, Hash, PartialEq, PartialOrd, Ord, Eq)]
pub enum DirOrFileWithBytes<'a> {
    Dir { path: PathBuf },
    File { path: PathBuf, bytes: &'a [u8] },
}

impl<'a> DirOrFileWithBytes<'a> {
    pub fn get_path(&self) -> &PathBuf {
        match self {
            DirOrFileWithBytes::Dir { path } => path,
            DirOrFileWithBytes::File { path, .. } => path,
        }
    }

    pub fn get_bytes(&self) -> Option<&'a [u8]> {
        match self {
            DirOrFileWithBytes::Dir { .. } => None,
            DirOrFileWithBytes::File { bytes, .. } => Some(bytes),
        }
    }
}

fn append_entries_recursive<'b>(
    header: &'b [u8],
    entries: Vec<FsEntry<'b>>,
    parent: &mut RecursiveFsEntryDir<'b>,
) {
    for entry in entries.iter() {
        match entry.fs_type {
            FsEntryType::Dir => {
                let mut subdir = RecursiveFsEntryDir {
                    name: entry.text.as_ref().to_string(),
                    contents: Vec::new(),
                };
                let offset_start: usize =
                    entry.offset_start.try_into().unwrap_or(u32::MAX as usize);
                let offset_end: usize = entry.offset_end.try_into().unwrap_or(u32::MAX as usize);
                let fs_entry_bytes = match get_byte_slice(header, offset_start, offset_end) {
                    Some(s) => s,
                    None => continue,
                };
                let new_entries = Volume::specialsort_dir(FsEntry::parse(fs_entry_bytes).as_ref());
                append_entries_recursive(header, new_entries, &mut subdir);
                parent.contents.push(RecursiveFsEntry::Dir { dir: subdir });
            }
            FsEntryType::File => {
                parent.contents.push(RecursiveFsEntry::File {
                    file: entry.clone(),
                });
            }
        }
    }
}

/// Since `env::temp_dir()` panics on wasm32-wasi, this
/// function provides a non-panicking replacement
pub fn webc_temp_dir() -> PathBuf {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::env::temp_dir()
    }
    #[cfg(target_arch = "wasm32")]
    {
        let random = rand::random::<u64>();

        let dir = std::env::current_exe()
            .unwrap_or(Path::new("").to_path_buf())
            .join(&format!("temp-{random}"));

        std::fs::create_dir_all(&dir).unwrap();

        dir
    }
}

fn to_leb(num: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    match leb128::write::unsigned(&mut buf, num) {
        Ok(_) => buf,
        Err(_) => Vec::new(),
    }
}

fn get_parent<P: AsRef<Path>>(path: P) -> String {
    match path.as_ref().parent() {
        Some(s) => format!("{}", s.display()),
        None => String::new(),
    }
}

// Returns how many bytes the LEB128 would take up if it was read
fn get_leb_size(bytes: &[u8]) -> Option<usize> {
    use std::io::Cursor;
    let mut cursor = Cursor::new(bytes);
    let initial_pos = cursor.position(); // usually 0
    let _ = leb128::read::unsigned(&mut cursor).ok()?;
    Some((cursor.position() - initial_pos).min(u32::MAX as u64) as usize)
}

fn from_leb(mut bytes: &[u8]) -> Option<u64> {
    leb128::read::unsigned(&mut bytes).ok()
}

// /a/b/c => "c"
// /a/b/c/file.txt => "file.txt"
fn get_last_component(path: &Path) -> Option<&str> {
    match path.components().last()? {
        Component::Normal(s) => s.to_str(),
        _ => None,
    }
}

/// Whether the file is a directory or a file
#[derive(Debug, Copy, Clone, PartialEq, PartialOrd, Eq, Ord, Hash)]
pub enum FsEntryType {
    /// File is a file
    File,
    /// File is a directory entry
    Dir,
}

impl FsEntryType {
    /// 8-Bit ID of the file entry type
    pub fn get_id(&self) -> u8 {
        match self {
            FsEntryType::Dir => 0,
            FsEntryType::File => 1,
        }
    }

    /// Reverse function of `self.get_id()`
    pub fn from_id(id: u8) -> Option<Self> {
        match id {
            0 => Some(FsEntryType::Dir),
            1 => Some(FsEntryType::File),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct RecursiveFsEntryDir<'a> {
    pub name: String,
    pub contents: Vec<RecursiveFsEntry<'a>>,
}

#[derive(Debug, PartialEq)]
pub enum RecursiveFsEntry<'a> {
    File { file: FsEntry<'a> },
    Dir { dir: RecursiveFsEntryDir<'a> },
}

/// Same as `FsEntry` but with an owned `text: String`,
/// instead of a `&str`
#[derive(Debug, Clone, PartialEq)]
pub enum OwnedFsEntry {
    /// File entry
    File(OwnedFsEntryFile),
    /// Directory entry
    Dir(OwnedFsEntryDir),
}

impl OwnedFsEntry {
    /// Returns the text component of the path, i.e. `"file.txt"` for `/a/b/file.txt`
    pub fn get_name(&self) -> &str {
        match self {
            OwnedFsEntry::File(f) => f.text.as_str(),
            OwnedFsEntry::Dir(d) => d.text.as_str(),
        }
    }
}

/// Owned version of the `FsEntry` with `fs_type = FsEntryType::File`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedFsEntryFile {
    /// Same as `FsEntry::text`, but owned as a `String`
    pub text: String,
    /// Starting offset in bytes into the `volume.data` field
    pub offset_start: u64,
    /// Ending offset in bytes into the `volume.data` field
    pub offset_end: u64,
}

impl OwnedFsEntryFile {
    pub fn get_len(&self) -> u64 {
        self.offset_end.saturating_sub(self.offset_start)
    }
}

/// Owned version of the `FsEntry` with `fs_type = FsEntryType::Dir`
#[derive(Debug, Clone, PartialEq)]
pub struct OwnedFsEntryDir {
    /// Same as `FsEntry::text`, but owned as a `String`
    pub text: String,
    /// Entries of the directory
    pub files: Vec<OwnedFsEntry>,
}

/// Directory or file entry, parsed without any allocation
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsEntry<'a> {
    /// If the `FsEntryType == Dir`, then `offset_start..offset_end` points
    /// to the start / end bytes of the next directory level, relative to the
    /// file header
    ///
    /// If the `FsEntryType = File`, then `offset_start..offset_end` points
    /// to the actual file contents in the `volume.data` field
    ///
    /// Inside of a directory level, all files are grouped by the name
    /// of the parent directory, at parsing time only the top-level
    /// directories are parsed
    pub fs_type: FsEntryType,
    /// Directory / file name, for example `usr`, `lib` or `var` in `"/usr/lib/var"`
    pub text: Cow<'a, str>,
    // See documentation for `fs_type`
    pub offset_start: u64,
    // See documentation for `fs_type`
    pub offset_end: u64,
}

impl<'a> FsEntry<'a> {
    /// Returns the length of the file in bytes (0 for directories)
    pub fn get_len(&self) -> u64 {
        self.offset_end.saturating_sub(self.offset_start)
    }

    pub fn calculate_byte_length(entries: &[Self]) -> usize {
        (entries.len() * 24)
            + entries
                .iter()
                .map(|e| e.text.as_bytes().len())
                .sum::<usize>()
            + 8
    }

    /// Serializes a list of `FsEntry` into bytes (usually
    /// done to encode one directory level)
    ///
    /// # Binary format
    ///
    /// ```no_run,ignore
    /// [8 bytes]: size of the directory level itself
    ///
    /// [
    ///   [1 byte]:  file entry type (0 = Directory, 1 = File, .. ?)
    ///   [7 bytes]: text length N (only 7 bytes long instead of 8, maximum file
    ///              name length = 268435456 instead of 4294967296 bytes)
    ///   [8 bytes]: offset_start
    ///   [8 bytes]: offset_end
    ///   [n bytes]: text (directory / file name)
    /// ]
    /// ```
    pub fn into_bytes(entries: &[Self]) -> Option<Vec<u8>> {
        let mut out = Vec::new();

        for entry in entries {
            let self_text_bytes = entry.text.as_bytes();

            // insanely long file name
            if self_text_bytes.len() > 268435456 {
                return None;
            }

            let mut text_len_bytes = (self_text_bytes.len() as u64).to_le_bytes();
            text_len_bytes[7] = entry.fs_type.get_id(); // 0th byte = least important byte
            out.extend_from_slice(&text_len_bytes);
            out.extend_from_slice(&entry.offset_start.to_le_bytes());
            out.extend_from_slice(&entry.offset_end.to_le_bytes());
            out.extend_from_slice(self_text_bytes);
        }

        let mut final_out = Vec::new();
        let len = out.len() as u64;
        let bytes_len = len.to_le_bytes();
        final_out.extend_from_slice(&bytes_len);
        final_out.append(&mut out);

        Some(final_out)
    }

    /// Reverse function of `Self::into_bytes`, parses one directory level
    /// from a set of bytes. One additional feature is that not more than `n`
    /// bytes are parsed if `n` is the size of the serialized directory level,
    /// even if the input buffer is larger than `n`.
    ///
    /// If the directory level could not be parsed, the parsing is interrupted
    /// and the given file entries are returns as-is (no check for completeness)
    pub fn parse(data: &'a [u8]) -> Vec<Self> {
        let mut entries = Vec::new();

        if data.is_empty() || data.len() < 8 {
            return entries;
        }

        // first 8 bytes = data len
        let directory_len_bytes = [
            data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
        ];

        let directory_len = u64::from_le_bytes(directory_len_bytes);
        let directory_len: usize = directory_len.try_into().unwrap_or(u32::MAX as usize);

        if data.len() < directory_len + 8 {
            return entries; // technically an error
        }

        let data = &data[8..directory_len + 8];

        let mut cursor = 0;
        while cursor < data.len() {
            let fs_type = data[cursor + 7]; // 0 = File, 1 = Directory
            if (cursor + 24) > data.len() {
                break;
            }

            let text_size = [
                data[cursor],
                data[cursor + 1],
                data[cursor + 2],
                data[cursor + 3],
                data[cursor + 4],
                data[cursor + 5],
                data[cursor + 6],
                0,
            ];
            let text_size = u64::from_le_bytes(text_size);

            let text_size: usize = text_size.try_into().unwrap_or(u32::MAX as usize);

            let offset_start = [
                data[cursor + 8],
                data[cursor + 9],
                data[cursor + 10],
                data[cursor + 11],
                data[cursor + 12],
                data[cursor + 13],
                data[cursor + 14],
                data[cursor + 15],
            ];
            let offset_start = u64::from_le_bytes(offset_start);

            let offset_end = [
                data[cursor + 16],
                data[cursor + 17],
                data[cursor + 18],
                data[cursor + 19],
                data[cursor + 20],
                data[cursor + 21],
                data[cursor + 22],
                data[cursor + 23],
            ];
            let offset_end = u64::from_le_bytes(offset_end);

            if (cursor + 24 + text_size) > data.len() {
                break; // directory corrupt?
            }

            let text_result = std::str::from_utf8(&data[cursor + 24..(cursor + 24 + text_size)]);

            cursor += 24 + text_size;

            let text = match text_result {
                Ok(o) => o,
                Err(_) => {
                    continue;
                }
            };

            let fs_type = match FsEntryType::from_id(fs_type) {
                Some(s) => s,
                None => {
                    continue;
                }
            };

            entries.push(FsEntry {
                fs_type,
                offset_start,
                offset_end,
                text: Cow::Borrowed(text),
            });
        }

        entries
    }
}

/// Header of a filesystem volume, describing a serialized
/// list of directories and file paths
#[derive(Default, Clone, PartialEq, Eq)]
pub struct VolumeHeader<'a> {
    /// Top-level files / directories already parsed
    pub top_level: Vec<FsEntry<'a>>,
    /// Unserialized header data as raw bytes
    pub header_data: &'a [u8],
}

impl<'a> fmt::Debug for VolumeHeader<'a> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.top_level.fmt(f)?;
        write!(
            f,
            "\r\nheader_data: [ ... ({} bytes) ],",
            self.header_data.len()
        )
    }
}

impl<'a> VolumeHeader<'a> {
    /// Parses the top-level directory entries from a slice of bytes,
    /// see `FsEntry::into_bytes` for information about the binary format
    pub fn from_slice(data: &'a [u8]) -> Self {
        Self {
            top_level: FsEntry::parse(data),
            header_data: data,
        }
    }

    /// Same as `&self.header_data`, API for consistency
    pub fn into_vec(&self) -> &'a [u8] {
        self.header_data
    }
}

/// Whether to sign the bytes when deserializing
/// the WebC file to bytes
#[derive(Debug, Clone, PartialEq)]
pub enum GenerateChecksum {
    /// Signature bytes get zeroed
    NoChecksum,
    /// Sha256 checksum of the file is calculated and padded
    /// with zeroes, but no signature is generated
    Sha256,
    /// Sha256 checksum is generated and the checksum
    /// is signed with the given key (cert must be able to
    /// sign at least 256 bytes)
    #[cfg(feature = "crypto")]
    SignedSha256 { key: Cert },
}

impl GenerateChecksum {
    /// Returns the ID for the Checksum type:
    ///
    /// - no checksum: `----------------`
    /// - sha256 checksum: `sha256----------`
    /// - sha256 checksum, signed with key: `sha256-signed---`
    ///
    pub fn get_key(&self) -> Vec<u8> {
        match self {
            GenerateChecksum::NoChecksum => b"----------------".to_vec(),
            GenerateChecksum::Sha256 => b"sha256----------".to_vec(),
            #[cfg(feature = "crypto")]
            GenerateChecksum::SignedSha256 { .. } => b"sha256-signed---".to_vec(),
        }
    }
}

impl Default for GenerateChecksum {
    fn default() -> Self {
        Self::NoChecksum
    }
}

/// Options on what to parse from the file
#[derive(Debug, Clone)]
pub struct ParseOptions {
    /// If set, will verify the file against the given public key
    /// and error out if the key does not match
    #[cfg(feature = "crypto")]
    pub key: Option<Cert>,
    /// If the manifest should be parsed (will be skipped over otherwise)
    pub parse_manifest: bool,
    /// If the filesystem should be parsed (will be empty otherwise)
    pub parse_volumes: bool,
    /// If the atoms should be parsed
    pub parse_atoms: bool,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            #[cfg(feature = "crypto")]
            key: None,
            parse_manifest: true,
            parse_volumes: true,
            parse_atoms: true,
        }
    }
}

#[allow(clippy::if_same_then_else)]
fn get_byte_slice(input: &[u8], start: usize, end: usize) -> Option<&[u8]> {
    if start == end && input.len() > start {
        Some(&input[start..end])
    } else if start < end && input.len() > start && input.len() >= end {
        Some(&input[start..end])
    } else {
        None
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct InternalPackageMeta {
    name: String,
    version: String,
}

/// Needed to easily deserialize an `WasiCommandAnnotation`
/// from the free-form `command.annotations`
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
struct WasiCommandAnnotationsDeserializer {
    #[serde(default)]
    wasi: Option<crate::metadata::annotations::Wasi>,
}

fn get_wasi_command_annotation(
    val: &IndexMap<String, ciborium::value::Value>,
) -> Option<crate::metadata::annotations::Wasi> {
    let desc: WasiCommandAnnotationsDeserializer = ciborium::Value::serialized(val)
        .unwrap()
        .deserialized()
        .unwrap();

    desc.wasi
}

/// Needed to easily deserialize an `EmscriptenCommandAnnotation`
/// from the free-form `command.annotations`
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
struct EmscriptenCommandAnnotationsDeserializer {
    #[serde(default)]
    emscripten: Option<Emscripten>,
}

fn get_emscripten_command_annotation(
    val: &IndexMap<String, ciborium::Value>,
) -> Option<Emscripten> {
    let desc: EmscriptenCommandAnnotationsDeserializer = ciborium::Value::serialized(val)
        .unwrap()
        .deserialized()
        .unwrap();
    desc.emscripten
}

impl<'a> WebC<'a> {
    pub fn get_main_args_for_command(&self, command: &str) -> Result<Vec<String>, String> {
        let command = self
            .manifest
            .commands
            .get(command)
            .ok_or(format!("Command {command:?} not found in manifest"))?;

        let atom_description =
            get_emscripten_command_annotation(&command.annotations).ok_or(format!(
                "no \"atom\" or \"wasi.atom\" or \"emscripten.atom\" found in command {command:#?}"
            ))?;

        let main_args = atom_description.main_args.as_ref().ok_or(format!(
            "command {command:?} has no atom to start the command with"
        ))?;

        Ok(main_args.clone())
    }

    #[allow(deprecated)]
    pub fn get_atom_name_for_command(&self, api: &str, command: &str) -> Result<String, String> {
        let command = self
            .manifest
            .commands
            .get(command)
            .ok_or(format!("Command {command:?} not found in manifest"))?;

        match api {
            "emscripten" => {
                let atom_description = get_emscripten_command_annotation(&command.annotations).ok_or(format!(
                    "no \"atom\" or \"wasi.atom\" or \"emscripten.atom\" found in command {command:#?}"
                ))?;

                let atom_name = atom_description.atom.as_ref().ok_or(format!(
                    "command {command:?} has no atom to start the command with"
                ))?;

                Ok(atom_name.to_string())
            }
            "wasi" => {
                let wasi = get_wasi_command_annotation(&command.annotations).ok_or(format!(
                    "no \"atom\" or \"wasi.atom\" or \"emscripten.atom\" found in command {command:#?}"
                ))?;

                Ok(wasi.atom)
            }
            _ => Err(String::new()),
        }
    }

    /// Checks whether the file starts with the header MAGIC
    pub fn check_magic_header(data: &[u8]) -> Result<(), Error> {
        let magic = get_byte_slice(data, 0, MAGIC.len()).ok_or(Error(
            "Invalid WebC file (can't get magic header)".to_string(),
        ))?;

        if magic != MAGIC {
            return Err(Error("Invalid Magic number".into()));
        }

        Ok(())
    }

    /// Determines the available volumes for a given package
    pub fn get_volumes_for_package(&self, package: &str) -> Vec<String> {
        if self.manifest.use_map.is_empty() {
            self.volumes.keys().cloned().collect()
        } else if package == self.get_package_name() {
            self.volumes
                .keys()
                .filter(|s| s.starts_with("self"))
                .cloned()
                .collect()
        } else {
            // TODO: inaccurate!
            self.volumes
                .keys()
                .filter(|s| s.contains(package))
                .cloned()
                .collect()
        }
    }

    pub fn list_directories(&self, volume: &str) -> Vec<String> {
        self.volumes
            .get(volume)
            .map(|v| v.list_directories())
            .unwrap_or_default()
    }

    /// Returns the directory entries or an error if the directory does not exist
    pub fn read_dir(&self, package: &str, path: &str) -> Result<Vec<FsEntry<'a>>, Error> {
        for volume in self.get_volumes_for_package(package) {
            let v = match self.volumes.get(&volume) {
                Some(s) => s,
                None => {
                    continue;
                }
            };

            match v.read_dir(path) {
                Ok(s) => {
                    return Ok(s);
                }
                Err(_) => {
                    continue;
                }
            }
        }

        Err(Error(format!(
            "\"{package}://{path}\" does not exist (os error 2)"
        )))
    }

    /// Looks for the first volume containing "entry", scoped to the given package
    pub fn get_file_entry(&self, package: &str, path: &str) -> Option<(String, OwnedFsEntryFile)> {
        let mut available_volumes = self.get_volumes_for_package(package);
        let mut path = path.to_string();
        let mut volume_selected = None;

        for v in available_volumes.iter() {
            let v_scheme = format!("{v}://");
            if path.starts_with(&v_scheme) {
                volume_selected = Some(v.clone());
                path = path.replacen(&v_scheme, "", 1);
                break;
            }
        }

        if let Some(v) = volume_selected.as_ref() {
            available_volumes = vec![v.clone()];
        }

        for volume in available_volumes {
            match self
                .volumes
                .get(&volume)
                .and_then(|v| v.get_file_entry(&path).ok())
            {
                Some(s) => return Some((volume.clone(), s)),
                None => continue,
            };
        }
        None
    }

    /// Checks whether the version of the file is supported by the parsing implementation
    pub fn get_check_version(data: &[u8]) -> Result<u64, Error> {
        let version = get_byte_slice(data, MAGIC.len(), MAGIC.len() + Version::V1.len()).ok_or(
            Error("Invalid WebC version (can't get version)".to_string()),
        )?;

        if version != Version::V1 {
            return Err(Error("Version not supported".into()));
        }

        let version = std::str::from_utf8(version)
            .map_err(|e| Error(format!("Invalid version: {e}")))?
            .parse::<u64>()
            .map_err(|e| Error(format!("Invalid version: {e}")))?;

        Ok(version)
    }

    /// Returns the bytes of the checksum
    pub fn get_checksum_bytes(data: &[u8]) -> Result<&[u8], Error> {
        get_byte_slice(
            data,
            MAGIC.len() + Version::V1.len() + 16,
            MAGIC.len() + Version::V1.len() + 16 + 256,
        )
        .ok_or(Error(
            "Invalid WebC checksum (can't get checksum)".to_string(),
        ))
    }

    /// Returns the offset of the manifest start
    pub fn get_manifest_offset_size(data: &[u8]) -> ReadResult<(usize, usize)> {
        let (signature_offset, _) = Self::get_signature_offset_size(data)?;
        let manifest_start = signature_offset + 1024;

        if data.get(manifest_start).is_none() {
            return Err(Error(format!(
                "Could not get manifest: data.len() < {manifest_start}"
            )));
        }

        let manifest_size_len = get_leb_size(&data[manifest_start..]).ok_or(Error(format!(
            "could not read LEB128 for manifest length at offset {manifest_start}"
        )))?;

        // actually parse the bytes
        let manifest_len = from_leb(&data[manifest_start..]).ok_or(Error(format!(
            "could not read LEB128 for manifest length at offset {manifest_start}"
        )))?;

        Ok((
            manifest_start + manifest_size_len,
            manifest_len.try_into().unwrap_or(u32::MAX as usize),
        ))
    }

    pub fn get_manifest(data: &[u8]) -> Result<Manifest, Error> {
        let (manifest_len_start, manifest_size) = Self::get_manifest_offset_size(data)?;

        let manifest = get_byte_slice(data, manifest_len_start, manifest_len_start + manifest_size)
            .ok_or(Error(
                "Invalid WebC manifest (can't get manifest bytes)".to_string(),
            ))?;

        ciborium::from_reader(manifest).map_err(|e| Error(format!("Failed to parse manifest: {e}")))
    }

    /// Returns the offset of the `.atoms` section of the file
    pub fn get_atoms_volume_offset_size(data: &[u8]) -> ReadResult<(usize, usize)> {
        let (manifest_offset, manifest_size) = Self::get_manifest_offset_size(data)?;

        let atom_start = manifest_offset + manifest_size;
        if data.get(atom_start).is_none() {
            return Err(Error(format!(
                "Could not get atom: data.len() < {atom_start}"
            )));
        }

        let atom_size_len = get_leb_size(&data[atom_start..]).ok_or(Error(format!(
            "could not read LEB128 for atom length at offset {atom_start}"
        )))?;

        let atom_len = from_leb(&data[atom_start..]).ok_or(Error(format!(
            "could not read LEB128 for atom length at offset {atom_start}"
        )))?;

        Ok((
            atom_start + atom_size_len,
            atom_len.try_into().unwrap_or(u32::MAX as usize),
        ))
    }

    /// Parses the `.atoms` section of the file
    pub fn get_atoms_volume(data: &'a [u8]) -> Result<Volume<'a>, Error> {
        let (atoms_volume_start, atoms_volume_size) = Self::get_atoms_volume_offset_size(data)?;

        let atoms_volume = get_byte_slice(
            data,
            atoms_volume_start,
            atoms_volume_start + atoms_volume_size,
        )
        .ok_or(Error(
            "Invalid WebC atoms (can't get atoms volume bytes)".to_string(),
        ))?;

        Volume::parse(atoms_volume).map_err(|e| Error(format!("Failed to parse atoms: {e}")))
    }

    /// Returns the offsets of the "volume"
    pub fn get_volume_data_offsets(data: &[u8]) -> Result<BTreeMap<String, (usize, usize)>, Error> {
        let mut results = BTreeMap::new();
        let (atoms_volume_start, atoms_volume_size) = Self::get_atoms_volume_offset_size(data)?;
        let mut cursor = atoms_volume_start + atoms_volume_size;
        let mut volume_id = 0;

        while get_byte_slice(data, cursor, data.len()).is_some() {
            let volume_name_len_len = get_leb_size(&data[cursor..]).ok_or(Error(format!(
                "Could not parse volume size length for volume {volume_id}"
            )))?;

            let volume_name_bytes_len = from_leb(&data[cursor..]).ok_or(Error(format!(
                "Could not parse volume size for volume {volume_id}"
            )))?;

            let volume_name_bytes_len: usize = volume_name_bytes_len
                .try_into()
                .unwrap_or(u32::MAX as usize);

            let start = cursor + volume_name_len_len;
            let end = start + volume_name_bytes_len;
            let volume_name_bytes = get_byte_slice(data, start, end)
                .ok_or(Error(format!("Failed to parse name of volume {volume_id:?}: Expected {volume_name_bytes_len} bytes at offset {start}..{end}")))?;

            let volume_name = std::str::from_utf8(volume_name_bytes)
            .map_err(|e| Error(format!("Failed to parse name of volume {volume_id:?} at offset {start}..{end}: {e}: {volume_name_bytes:?}")))?;

            let volume_size_start = end;
            let _ = get_byte_slice(data, volume_size_start, data.len())
            .ok_or(Error(format!("Failed to parse size of volume {volume_name:?}: Expected LEB128 at offset {volume_size_start}")))?;

            let volume_size_len = get_leb_size(&data[volume_size_start..])
            .ok_or(Error(format!("Failed to parse size of volume {volume_name:?}: Expected LEB128 at offset {volume_size_start}")))?;
            let volume_size_end = volume_size_start + volume_size_len;
            let volume_size = from_leb(&data[volume_size_start..])
            .ok_or(Error(format!("Failed to parse size of volume {volume_name:?}: Expected LEB128 at offset {volume_size_start} + {volume_size_len}")))?;

            let volume_size: usize = volume_size.try_into().unwrap_or(u32::MAX as usize);
            let volume_start = volume_size_end;
            let volume_end = volume_start + volume_size;

            let leb_size = get_leb_size(&data[volume_start..volume_end]).ok_or(Error(
                "Error parsing volume: could not read header size LEB128".to_string(),
            ))?;

            let header_len: usize = from_leb(&data[volume_start..volume_end])
                .ok_or(Error(format!(
                    "Could not read header length from data (first {leb_size} bytes)"
                )))?
                .try_into()
                .unwrap_or(usize::MAX);

            let volume_start = volume_start + leb_size + header_len;

            results.insert(volume_name.to_string(), (volume_start, volume_end));
            cursor = volume_end;
            volume_id += 1;
        }

        Ok(results)
    }

    pub fn parse_volumes_from_fileblock(
        data: &'a [u8],
    ) -> ReadResult<IndexMap<String, Volume<'a>>> {
        let mut map = IndexMap::new();
        let mut volume_id = 0;
        let mut cursor = 0;

        while get_byte_slice(data, cursor, data.len()).is_some() {
            let volume_name_len_len = get_leb_size(&data[cursor..]).ok_or(Error(format!(
                "Could not parse volume size length for volume {volume_id}"
            )))?;

            let volume_name_bytes_len = from_leb(&data[cursor..]).ok_or(Error(format!(
                "Could not parse volume size for volume {volume_id}"
            )))?;

            let volume_name_bytes_len: usize = volume_name_bytes_len
                .try_into()
                .unwrap_or(u32::MAX as usize);

            let start = cursor + volume_name_len_len;
            let end = start + volume_name_bytes_len;
            let volume_name_bytes = get_byte_slice(data, start, end)
                .ok_or(Error(format!("Failed to parse name of volume {volume_id:?}: Expected {volume_name_bytes_len} bytes at offset {start}..{end}")))?;

            let volume_name = std::str::from_utf8(volume_name_bytes)
            .map_err(|e| Error(format!("Failed to parse name of volume {volume_id:?} at offset {start}..{end}: {e}: {volume_name_bytes:?}")))?;

            let volume_size_start = end;
            let _ = get_byte_slice(data, volume_size_start, data.len())
            .ok_or(Error(format!("Failed to parse size of volume {volume_name:?}: Expected LEB128 at offset {volume_size_start}")))?;

            let volume_size_len = get_leb_size(&data[volume_size_start..])
            .ok_or(Error(format!("Failed to parse size of volume {volume_name:?}: Expected LEB128 at offset {volume_size_start}")))?;
            let volume_size_end = volume_size_start + volume_size_len;
            let volume_size = from_leb(&data[volume_size_start..])
            .ok_or(Error(format!("Failed to parse size of volume {volume_name:?}: Expected LEB128 at offset {volume_size_start} + {volume_size_len}")))?;

            let volume_size: usize = volume_size.try_into().unwrap_or(u32::MAX as usize);
            let volume_start = volume_size_end;
            let volume_end = volume_start + volume_size;
            let volume_bytes = get_byte_slice(data, volume_start, volume_end)
            .ok_or(Error(format!("Failed to parse size of volume {volume_name:?}: Expected {volume_size} bytes at offset {volume_start}..{volume_end}")))?;

            let volume = Volume::parse(volume_bytes).map_err(|e| {
                Error(format!(
                    "Failed to parse volume {volume_name:?} (size = {volume_size} bytes): {e}"
                ))
            })?;

            map.insert(volume_name.to_string(), volume);

            cursor = volume_end;
            volume_id += 1;
        }

        Ok(map)
    }

    /// Parses the `.volumes` section(s) of the file
    pub fn parse_volumes(data: &'a [u8]) -> ReadResult<IndexMap<String, Volume<'a>>> {
        let (atoms_volume_start, atoms_volume_size) = Self::get_atoms_volume_offset_size(data)?;
        let cursor = atoms_volume_start + atoms_volume_size;
        match get_byte_slice(data, cursor, data.len()) {
            Some(s) => Self::parse_volumes_from_fileblock(s),
            None => Ok(IndexMap::new()),
        }
    }

    /// Computes the checksum of the file without cloning it
    pub fn compute_checksum(data: &[u8]) -> ReadResult<Option<Checksum>> {
        use sha2::Sha256;

        let min_offset = MAGIC.len() + Version::V1.len();
        let max_offset = min_offset + 16;
        let checksum_type = get_byte_slice(data, min_offset, max_offset).ok_or(Error(format!(
            "Failed to get checksum type at offset {min_offset}..{max_offset}"
        )))?;

        match checksum_type {
            b"----------------" => Ok(None),
            b"sha256----------" | b"sha256-signed---" => {
                let mut hasher = Sha256::new();

                hasher.update(MAGIC);
                hasher.update(Version::V1);
                hasher.update(checksum_type);
                hasher.update([0; 256]);
                hasher.update([0; 4]);
                hasher.update([0; 1024]);

                if data.len() > MAGIC.len() + Version::V1.len() + 16 + 256 + 4 + 1024 {
                    hasher.update(&data[(MAGIC.len() + Version::V1.len() + 16 + 256 + 4 + 1024)..]);
                };

                let mut result = hasher.finalize().to_vec();
                let valid_until = result.len();

                if result.len() < 256 {
                    result.resize(256, 0);
                }

                let chk_type = std::str::from_utf8(checksum_type).unwrap().to_string();

                Ok(Some(Checksum {
                    valid_until,
                    chk_type,
                    data: result,
                    valid: false,
                }))
            }
            _ => Err(Error(format!(
                "Invalid checksum type: {:?}",
                std::str::from_utf8(checksum_type)
            ))),
        }
    }

    pub const fn get_signature_offset_start() -> usize {
        MAGIC.len() + Version::V1.len() + 16 + 256
    }

    /// Returns the offset of the signature
    pub fn get_signature_offset_size(data: &[u8]) -> ReadResult<(usize, usize)> {
        let signature_offset_start = Self::get_signature_offset_start();
        let signature_size_bytes =
            get_byte_slice(data, signature_offset_start, signature_offset_start + 4).ok_or(
                Error(format!(
                    "Failed to get signature length at offset {signature_offset_start}..{}",
                    signature_offset_start + 4
                )),
            )?;

        let signature_len_u32 = u32::from_le_bytes([
            signature_size_bytes[0],
            signature_size_bytes[1],
            signature_size_bytes[2],
            signature_size_bytes[3],
        ]);

        let signature_len = signature_len_u32.min(1024) as usize;

        Ok((signature_offset_start + 4, signature_len))
    }

    /// Read the signature bytes
    pub fn get_signature_bytes(data: &[u8]) -> ReadResult<&[u8]> {
        let (offset, size) = Self::get_signature_offset_size(data)?;

        get_byte_slice(data, offset, offset + size).ok_or(Error(format!(
            "Could not get signature at offset {}..{}",
            offset,
            offset + size
        )))
    }

    /// Returns the (unverified) signature from the file
    pub fn get_signature(data: &[u8]) -> ReadResult<Option<Signature>> {
        let signature = Self::get_signature_bytes(data)?;
        let last_bytes = signature.iter().rev().take_while(|i| **i == 0).count();
        let valid_until = 1024_usize.saturating_sub(last_bytes);
        Ok(Some(Signature {
            valid_until,
            data: signature.to_vec(),
            valid: false,
        }))
    }

    /// Verifies the file against a given key
    #[cfg(feature = "crypto")]
    pub fn verify_file(
        checksum: &Checksum,
        signature: &Signature,
        public_key: &Cert,
    ) -> ReadResult<bool> {
        verify_signature(&checksum.data, &signature.data, public_key)
            .map_err(|e| Error(format!("Error verifying signature: {e}")))
    }

    /// Returns a reference to the manifest
    pub fn get_metadata(&self) -> &Manifest {
        &self.manifest
    }

    /// Returns the current package name with
    pub fn get_package_name(&self) -> String {
        Self::get_package_name_from_manifest(&self.manifest)
    }

    fn get_package_name_from_manifest(m: &Manifest) -> String {
        m.package
            .get("wapm")
            .map(|value| {
                let meta: InternalPackageMeta = value.deserialized().unwrap();
                format!("{}@{}", meta.name, meta.version)
            })
            .or_else(|| {
                let name = m.package.get("name")?;
                let name = match name {
                    ciborium::Value::Text(t) => t,
                    _ => return None,
                };
                let version = m.package.get("version")?;
                let version = match version {
                    ciborium::Value::Text(t) => t,
                    _ => return None,
                };
                Some(format!("{name}@{version}"))
            })
            .unwrap_or_default()
    }

    /// Returns an atom by name for a given package
    pub fn get_atom(&self, package: &str, atom: &str) -> Result<&[u8], Error> {
        let full_atom_name = format!("{package}:{atom}");
        match self.atoms.get_file(&full_atom_name) {
            Ok(o) => Ok(o),
            Err(e) => {
                // look for the atom without the package name,
                // if it's the current package name
                if package != self.get_package_name() {
                    return Err(e);
                }

                self.atoms.get_file(atom)
            }
        }
    }

    /// Returns a reference to the filesystem volume of the package
    pub fn get_volume(&self, package: &str, volume: &str) -> Option<&Volume<'a>> {
        match self.volumes.get(&format!("{package}/{volume}")) {
            Some(s) => Some(s),
            None => {
                if package == self.get_package_name() {
                    self.volumes.get(volume)
                } else {
                    None
                }
            }
        }
    }

    /// Returns a file for a given package - if you want to use a non-default
    /// volume, prefix the `file_path` with `volume://`, for example, `metadata://README.md`
    pub fn get_file(&self, package: &str, file_path: &str) -> Result<&[u8], Error> {
        // if the file path starts with "{volume}://", see if the package has a given volume
        let (volume, path) =
            Self::get_volume_name_from_path(file_path).unwrap_or(("atom", file_path));
        let full_volume_name = format!("{package}/{volume}");
        let volume = match self.volumes.get(&full_volume_name) {
            Some(o) => o,
            None => {
                // look for the volume without the package name,
                // if it's the current package name
                if package != self.get_package_name() {
                    return Err(Error(format!("Could not find volume {full_volume_name:?}")));
                }

                self.volumes
                    .get(volume)
                    .ok_or(Error(format!("Could not find volume {volume:?}")))?
            }
        };
        volume.get_file(path)
    }

    fn get_volume_name_from_path(s: &str) -> Option<(&str, &str)> {
        let (volume, path) = s.split_once("://")?;
        if !s.starts_with(&format!("{volume}://")) {
            None
        } else {
            Some((volume, path))
        }
    }

    /// Returns a list of volumes for this package
    pub fn list_volumes(&self, package: &str) -> Vec<String> {
        let mut result = Vec::new();
        let search = format!("{package}/");
        for k in self.volumes.keys() {
            if k.starts_with(&search) {
                result.push(k.replacen(&search, "", 1));
            }
        }
        result
    }

    /// Returns a list of bundled "package@version" strings contained in this package
    pub fn list_packages(&self) -> Vec<PackageInfo> {
        let mut packages = vec![PackageInfo::Internal {
            dependency_path: String::new(),
            name: self.get_package_name(),
        }];
        Self::get_packages_recursive("self", &self.manifest.use_map, &mut packages);
        packages.sort();
        packages.dedup();
        packages
    }

    fn get_packages_recursive(
        parent_manifest: &str,
        use_map: &IndexMap<String, UrlOrManifest>,
        packages: &mut Vec<PackageInfo>,
    ) {
        for (k, v) in use_map.iter() {
            match v {
                UrlOrManifest::Url(u) => {
                    packages.push(PackageInfo::External {
                        name: k.clone(),
                        url: u.clone(),
                    });
                }
                UrlOrManifest::RegistryDependentUrl(u) => {
                    packages.push(PackageInfo::RegistryExternal {
                        name: k.clone(),
                        id: u.clone(),
                    });
                }
                UrlOrManifest::Manifest(m) => {
                    let name = Self::get_package_name_from_manifest(m);
                    packages.push(PackageInfo::Internal {
                        dependency_path: parent_manifest.to_string(),
                        name: name.clone(),
                    });
                    let dependency_path = format!("{parent_manifest}::{name}");
                    Self::get_packages_recursive(&dependency_path, &m.use_map, packages);
                }
            }
        }
    }

    /// Returns the atoms in the root package
    pub fn list_atoms(&self) -> Vec<String> {
        self.list_atoms_for_package(&self.get_package_name())
    }

    /// Returns a list of all atoms with bytes
    pub fn get_all_atoms(&self) -> IndexMap<String, &'a [u8]> {
        self.atoms
            .header
            .top_level
            .iter()
            .filter_map(|fs_entry| {
                Some((
                    fs_entry.text.to_string(),
                    self.atoms
                        .get_file_bytes(&OwnedFsEntryFile {
                            text: fs_entry.text.to_string(),
                            offset_start: fs_entry.offset_start,
                            offset_end: fs_entry.offset_end,
                        })
                        .ok()?,
                ))
            })
            .collect()
    }

    /// List the atoms for a given package
    pub fn list_atoms_for_package(&self, package_orig: &str) -> Vec<String> {
        let package = format!("{package_orig}:");
        self.atoms
            .header
            .top_level
            .iter()
            .filter_map(|fs_entry| {
                if !fs_entry.text.contains(':') && !fs_entry.text.contains('@') {
                    Some(fs_entry.text.to_string())
                } else if !fs_entry.text.starts_with(&format!("{package_orig}::"))
                    && fs_entry.text.starts_with(&package)
                {
                    Some(fs_entry.text.replacen(&package, "", 1))
                } else if !fs_entry.text.starts_with("self::")
                    && fs_entry.text.starts_with("self:")
                    && package_orig == self.get_package_name()
                {
                    Some(fs_entry.text.to_string())
                } else {
                    None
                }
            })
            .collect()
    }

    /// List the available commands for the root package
    pub fn list_commands(&self) -> Vec<&str> {
        self.get_metadata()
            .commands
            .keys()
            .map(|s| s.as_str())
            .collect()
    }

    /// Parses the entire file, depending on the `ParseOptions`
    #[allow(unused_variables)]
    pub fn parse(data: &'a [u8], options: &ParseOptions) -> ReadResult<Self> {
        Self::check_magic_header(data)?;
        let version = Self::get_check_version(data)?;
        let mut checksum = Self::compute_checksum(data)?;
        #[allow(unused_mut)]
        let mut signature = Self::get_signature(data)?;
        let checksum_bytes = Self::get_checksum_bytes(data)?;

        if let Some(checksum) = checksum.as_mut() {
            checksum.valid = checksum.data == checksum_bytes;
        }

        #[cfg(feature = "crypto")]
        match (options.key.as_ref(), checksum.as_mut(), signature.as_mut()) {
            (Some(key), Some(checksum), Some(signature)) if checksum.valid => {
                signature.valid = verify_signature(&checksum.data, &signature.data, key).is_ok();
            }
            _ => {}
        }

        let manifest = Self::get_manifest(data)?;
        let atoms_volume = Self::get_atoms_volume(data)?;
        let volumes = Self::parse_volumes(data)?;

        Ok(WebC {
            version,
            checksum,
            signature,
            manifest,
            atoms: atoms_volume,
            volumes,
        })
    }

    pub fn get_volumes_as_fileblock(&self) -> Vec<u8> {
        let mut file = Vec::new();

        for (volume_name, volume) in self.volumes.iter() {
            // Serialize volume name
            let volume_name_bytes = volume_name.as_bytes();
            file.extend_from_slice(&to_leb(volume_name_bytes.len() as u64));
            file.extend(volume_name_bytes);

            // Serialize volume content
            let volume_serialized = volume.into_bytes();
            file.extend_from_slice(&to_leb(volume_serialized.len() as u64));
            file.extend(&volume_serialized);
        }

        file
    }

    /// Serialize the .webc file into bytes
    pub fn into_bytes(&self, sign_bytes: GenerateChecksum) -> ReadResult<Vec<u8>> {
        use sha2::Sha256;

        let mut file: Vec<u8> = vec![];

        file.extend(MAGIC);
        file.extend(*Version::V1);

        // 16 bytes: signature algo
        file.extend(sign_bytes.get_key());
        // 256 bytes: Reserve space reserved for checksum
        file.extend([0; 256]);
        // 4 bytes: Length of the signature in bytes
        file.extend([0; 4]);
        // 1024 bytes: Space reserved for the signature
        file.extend([0; 1024]);

        // N bytes: length of manifest + manifest
        let mut manifest_serialized = vec![];
        ciborium::into_writer(&self.manifest, &mut manifest_serialized).unwrap();

        file.extend_from_slice(&to_leb(manifest_serialized.len() as u64));
        file.extend(manifest_serialized);

        // Serialize "atoms" volume
        let atoms_volume = self.atoms.into_bytes();
        file.extend_from_slice(&to_leb(atoms_volume.len() as u64));
        file.extend_from_slice(&atoms_volume);

        for (volume_name, volume) in self.volumes.iter() {
            // Serialize volume name
            let volume_name_bytes = volume_name.as_bytes();
            file.extend_from_slice(&to_leb(volume_name_bytes.len() as u64));
            file.extend(volume_name_bytes);

            // Serialize volume content
            let volume_serialized = volume.into_bytes();
            file.extend_from_slice(&to_leb(volume_serialized.len() as u64));
            file.extend(&volume_serialized);
        }

        // Generate 256-byte checksum depending on requested algo
        let checksum = match sign_bytes {
            GenerateChecksum::NoChecksum => vec![0; 256],
            _ => {
                let mut hasher = Sha256::new();
                hasher.update(&file);
                let mut result = hasher.finalize().to_vec();
                if result.len() > 256 {
                    return Err(Error("SHA256 returned >256 byte hash (?)".to_string()));
                }
                if result.len() < 256 {
                    result.resize(256, 0);
                }
                result
            }
        };

        assert_eq!(checksum.len(), 256);

        // update checksum
        let idx_start = MAGIC.len() + Version::V1.len() + sign_bytes.get_key().len();
        let idx_end = idx_start + checksum.len();
        for (i, c) in (idx_start..idx_end).zip(checksum.iter()) {
            file[i] = *c;
        }

        let (sig_len, signature) = match &sign_bytes {
            GenerateChecksum::NoChecksum | GenerateChecksum::Sha256 => (0_u32, vec![0; 1024]),
            #[cfg(feature = "crypto")]
            GenerateChecksum::SignedSha256 { key } => {
                let mut sig = create_signature(key, &checksum)
                    .map_err(|e| Error(format!("Failed to sign checksum: {e}")))?;

                let len = sig.len();

                if sig.len() > 1024 {
                    // TODO(felix): better error handling
                    return Err(Error(format!(
                        "Signature length out of bounds: {} bytes, max 1024 bytes",
                        sig.len()
                    )));
                }

                if sig.len() < 1024 {
                    sig.resize(1024, 0);
                }

                (len as u32, sig)
            }
        };

        let sig_len_bytes = sig_len.to_le_bytes().to_vec();

        assert_eq!(sig_len_bytes.len(), 4);

        // update signature length
        let idx_start = idx_end;
        let idx_end = idx_start + sig_len_bytes.len();
        for (i, c) in (idx_start..idx_end).zip(sig_len_bytes.into_iter()) {
            file[i] = c;
        }

        assert_eq!(signature.len(), 1024);

        // update signature
        let idx_start = idx_end;
        let idx_end = idx_start + signature.len();
        for (i, c) in (idx_start..idx_end).zip(signature.into_iter()) {
            file[i] = c;
        }

        Ok(file)
    }
}

/// Information about the package name
#[derive(Debug, Clone, PartialEq, PartialOrd, Eq, Ord, Serialize, Deserialize)]
pub enum PackageInfo {
    /// External dependency, ex. `"abc": "https://myhost.io/package/abc@1.2.3"`
    External { name: String, url: Url },
    /// External dependency that depends on a registry for resolving the file
    /// URL, ex. `"abc": "package/abc@1.2.3"`
    RegistryExternal { name: String, id: String },
    /// Internal (vendored) dependency
    Internal {
        dependency_path: String,
        name: String,
    },
}

#[cfg(feature = "crypto")]
fn create_signature(cert: &Cert, message: &[u8]) -> Result<Vec<u8>, Error> {
    use sequoia_openpgp::policy::StandardPolicy as P;
    use sequoia_openpgp::serialize::stream::Message;
    use sequoia_openpgp::serialize::stream::Signer;
    use std::io::Write;

    let policy = &P::new();

    let keypair = cert
        .keys()
        .unencrypted_secret()
        .with_policy(policy, None)
        .supported()
        .alive()
        .revoked(false)
        .for_signing()
        .next()
        .unwrap()
        .key()
        .clone()
        .into_keypair()
        .map_err(|e| Error(format!("{e}")))?;

    let mut target = Vec::new();
    let sink = Message::new(&mut target);

    let mut signer = Signer::new(sink, keypair)
        .detached()
        .build()
        .map_err(|e| Error(format!("{e}")))?;
    signer
        .write_all(message)
        .map_err(|e| Error(format!("{e}")))?;
    signer.finalize().map_err(|e| Error(format!("{e}")))?;

    Ok(target)
}

// Verifies the signature of a .webc file where checksum = computed checksum of the
// file with zeroed signature + signature, public_key = the public key to verify against
#[cfg(feature = "crypto")]
fn verify_signature(
    checksum: &[u8],
    signature: &[u8],
    public_key: &Cert,
) -> Result<bool, anyhow::Error> {
    use sequoia_openpgp::parse::Parse;
    use sequoia_openpgp::policy::StandardPolicy as P;

    let policy = &P::new();

    // Make a helper that that feeds the sender's
    // public key to the verifier.
    let helper = CertVerifier { cert: public_key };

    // Now, create a verifier with a helper using the given Certs.
    let mut verifier =
        DetachedVerifierBuilder::from_bytes(signature)?.with_policy(policy, None, helper)?;

    // Verify the data.
    verifier.verify_bytes(checksum)?;

    Ok(true)
}

#[cfg(feature = "crypto")]
struct CertVerifier<'a> {
    cert: &'a Cert,
}

#[cfg(feature = "crypto")]
impl<'a> VerificationHelper for CertVerifier<'a> {
    /// Impl to return the public keys for verification based on the given handle
    fn get_certs(
        &mut self,
        _ids: &[sequoia_openpgp::KeyHandle],
    ) -> sequoia_openpgp::Result<Vec<Cert>> {
        Ok(vec![self.cert.clone()])
    }

    /// Impl to verify the signature with the public key
    fn check(&mut self, structure: MessageStructure<'_>) -> sequoia_openpgp::Result<()> {
        let mut good = false;

        for (i, layer) in structure.into_iter().enumerate() {
            match (i, layer) {
                (0, MessageLayer::SignatureGroup { results }) => match results.into_iter().next() {
                    Some(Ok(_)) => good = true,
                    Some(Err(e)) => return Err(sequoia_openpgp::Error::from(e).into()),
                    None => return Err(anyhow::anyhow!("No signature")),
                },
                _ => return Err(anyhow::anyhow!("Unexpected message structure")),
            }
        }

        if !good {
            return Err(anyhow::anyhow!("Signature verification failed"));
        }

        Ok(())
    }
}

pub type FileMap = BTreeMap<DirOrFile, Vec<u8>>;

pub fn pack_directory(dir: &Path) -> Result<FileMap, String> {
    let mut files = BTreeMap::new();

    // by default, this builder will ignore:
    // - entries in .git/info/exclude
    // - entries in .gitignore
    // - hidden files
    let walker = ignore::WalkBuilder::new(dir).build();

    for entry in walker {
        let entry = entry.as_ref().map_err(|e| format!("{entry:?}: {e}"))?;

        let original_path = entry.path();
        let path = original_path.strip_prefix(dir).unwrap_or(original_path);
        let file_str = path.display().to_string();
        if file_str.is_empty() {
            continue;
        }

        if original_path.is_dir() {
            files.insert(DirOrFile::Dir(path.to_path_buf()), Vec::new());
        } else {
            let file_contents =
                std::fs::read(original_path).map_err(|e| format!("{file_str:?}: {e}"))?;
            files.insert(DirOrFile::File(path.to_path_buf()), file_contents);
        }
    }

    Ok(files)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use tempfile::tempdir;
    use FsEntryType::*;

    #[test]
    fn ignore_hidden_and_git_related() {
        let root = tempdir().unwrap();

        let _hidden = std::fs::File::create(root.path().join(".hidden")).unwrap();

        let _git = std::fs::File::create(root.path().join(".git")).unwrap();

        let mut gitignore = std::fs::File::create(root.path().join(".gitignore")).unwrap();
        gitignore.write_all(b"ignore_me").unwrap();

        let _ignore_me = std::fs::File::create(root.path().join("ignore_me")).unwrap();

        let _include_me = std::fs::File::create(root.path().join("include_me")).unwrap();

        let map = pack_directory(root.path()).unwrap();

        // These files must be excluded:
        // - .git
        // - .gitignore
        // - .hidden
        // - ignore_me
        assert_eq!(map.len(), 1);
        assert!(map.contains_key(&DirOrFile::File("include_me".parse().unwrap())));
    }

    #[test]
    fn serialize_header_entry() {
        let entry = HeaderEntry {
            flags: Flags::File,
            offset_start: 23,
            offset_end: 1024,
            text: "file.txt".parse().unwrap(),
        };

        let mut buffer = Vec::new();
        entry.write_to(&mut buffer);

        assert_bytes_eq!(
            buffer,
            bytes! {
                text_length("file.txt"),
                Flags::File,
                23_u64.to_le_bytes(),
                1024_u64.to_le_bytes(),
                "file.txt",
            }
        );
    }

    #[test]
    fn test_specialsort_append_to_target() {
        let mut map = BTreeMap::new();

        map.insert(
            DirOrFile::File(Path::new("10.txt").to_path_buf()),
            b"hello".to_vec(),
        );
        map.insert(
            DirOrFile::File(Path::new("104.txt").to_path_buf()),
            b"hello".to_vec(),
        );
        map.insert(DirOrFile::Dir(Path::new("a100").to_path_buf()), Vec::new());
        map.insert(DirOrFile::Dir(Path::new("a101").to_path_buf()), Vec::new());
        map.insert(
            DirOrFile::File(Path::new("a101/test.txt").to_path_buf()),
            b"hello".to_vec(),
        );
        map.insert(
            DirOrFile::File(Path::new("file1.txt").to_path_buf()),
            b"hello".to_vec(),
        );
        map.insert(
            DirOrFile::File(Path::new("file4.txt").to_path_buf()),
            b"hello".to_vec(),
        );
        map.insert(
            DirOrFile::File(Path::new("file2.txt").to_path_buf()),
            b"hello".to_vec(),
        );

        let volume_bytes = Volume::serialize_files(map);
        let volume = Volume::parse(&volume_bytes).unwrap();
        assert_eq!(
            volume.get_all_file_entries_directorysorted(),
            vec![
                (
                    DirOrFile::Dir(Path::new("a100").to_path_buf()),
                    FsEntry {
                        fs_type: Dir,
                        text: Cow::Borrowed("a100"),
                        offset_start: 224,
                        offset_end: 224
                    }
                ),
                (
                    DirOrFile::Dir(Path::new("a101").to_path_buf()),
                    FsEntry {
                        fs_type: Dir,
                        text: Cow::Borrowed("a101"),
                        offset_start: 224,
                        offset_end: 264
                    }
                ),
                (
                    DirOrFile::File(Path::new("a101/test.txt").to_path_buf()),
                    FsEntry {
                        fs_type: File,
                        text: Cow::Borrowed("test.txt"),
                        offset_start: 10,
                        offset_end: 15
                    }
                ),
                (
                    DirOrFile::File(Path::new("10.txt").to_path_buf()),
                    FsEntry {
                        fs_type: File,
                        text: Cow::Borrowed("10.txt"),
                        offset_start: 0,
                        offset_end: 5
                    }
                ),
                (
                    DirOrFile::File(Path::new("104.txt").to_path_buf()),
                    FsEntry {
                        fs_type: File,
                        text: Cow::Borrowed("104.txt"),
                        offset_start: 5,
                        offset_end: 10
                    }
                ),
                (
                    DirOrFile::File(Path::new("file1.txt").to_path_buf()),
                    FsEntry {
                        fs_type: File,
                        text: Cow::Borrowed("file1.txt"),
                        offset_start: 15,
                        offset_end: 20
                    }
                ),
                (
                    DirOrFile::File(Path::new("file2.txt").to_path_buf()),
                    FsEntry {
                        fs_type: File,
                        text: Cow::Borrowed("file2.txt"),
                        offset_start: 20,
                        offset_end: 25
                    }
                ),
                (
                    DirOrFile::File(Path::new("file4.txt").to_path_buf()),
                    FsEntry {
                        fs_type: File,
                        text: Cow::Borrowed("file4.txt"),
                        offset_start: 25,
                        offset_end: 30
                    }
                ),
            ]
        );
    }

    #[test]
    fn webc_invalid_data() {
        let content = WebC::parse(b"Nweb", &ParseOptions::default());
        pretty_assertions::assert_eq!(
            content.unwrap_err().0.as_str(),
            "Invalid WebC file (can\'t get magic header)"
        );

        let content = WebC::parse(b"\0webc0x1", &ParseOptions::default());
        pretty_assertions::assert_eq!(content.unwrap_err().0.as_str(), "Version not supported");

        let content = WebC::parse(b"\0webc001", &ParseOptions::default());
        pretty_assertions::assert_eq!(
            content.unwrap_err().0.as_str(),
            "Failed to get checksum type at offset 8..24"
        );

        pretty_assertions::assert_eq!(
            WebC::compute_checksum(b"\0webc001----------------"),
            Ok(None)
        );

        let content = WebC::parse(b"\0webc001----------------", &ParseOptions::default());
        pretty_assertions::assert_eq!(
            content.unwrap_err().0.as_str(),
            "Failed to get signature length at offset 280..284"
        );
    }

    #[test]
    fn test_encode_decode_file_entry() {
        use crate::v1::FsEntryType::*;
        use std::borrow::Cow;
        let entries = vec![
            FsEntry {
                fs_type: Dir,
                text: Cow::Borrowed("a"),
                offset_start: 58,
                offset_end: 91,
            },
            FsEntry {
                fs_type: Dir,
                text: Cow::Borrowed("b"),
                offset_start: 91,
                offset_end: 91,
            },
        ];

        pretty_assertions::assert_eq!(
            FsEntry::parse(&FsEntry::into_bytes(&entries).unwrap_or_default()),
            entries
        );
    }

    #[test]
    fn test_volume() {
        let mut files = BTreeMap::new();
        files.insert(
            DirOrFile::File(Path::new("/a/c/file.txt").to_path_buf()),
            b"hello".to_vec(),
        );
        files.insert(DirOrFile::Dir(Path::new("/b").to_path_buf()), Vec::new());
        let volume_bytes = Volume::serialize_files(files);
        let volume = Volume::parse(&volume_bytes).unwrap();
        pretty_assertions::assert_eq!(volume.get_file("/a/c/file.txt"), Ok(&b"hello"[..]));
    }

    #[test]
    fn test_encode_decode_webc() {
        let mut files = BTreeMap::new();
        files.insert(
            DirOrFile::File(Path::new("atom.wasm").to_path_buf()),
            b"atom wasm content".to_vec(),
        );
        let atom_volume = Volume::serialize_atoms(files);
        let atom_volume = Volume::parse(&atom_volume).unwrap();

        let mut files = BTreeMap::new();
        files.insert(
            DirOrFile::File(Path::new("dependency.txt").to_path_buf()),
            b"dependency!".to_vec(),
        );
        let file_volume = Volume::serialize_files(files);
        let file_volume = Volume::parse(&file_volume).unwrap();

        let webc = WebC {
            version: 1,
            checksum: None,
            signature: Some(Signature {
                valid_until: 1024,
                valid: false,
                data: Vec::new(),
            }),
            manifest: Manifest {
                origin: None,
                use_map: IndexMap::default(),
                package: IndexMap::default(),
                atoms: IndexMap::default(),
                commands: IndexMap::default(),
                bindings: Vec::new(),
                entrypoint: None,
            },
            atoms: atom_volume,
            volumes: {
                let mut map = IndexMap::default();
                map.insert("files".to_string(), file_volume);
                map
            },
        };

        let bytes = webc.into_bytes(GenerateChecksum::NoChecksum).unwrap();

        pretty_assertions::assert_eq!(WebC::parse(&bytes, &ParseOptions::default()).unwrap(), webc);
    }

    #[test]
    fn test_insert_wrong_file() {
        let volume_bytes = Volume::serialize_files(
            [(
                DirOrFile::File(Path::new("/a/b/c/test.txt").to_path_buf()),
                b"hello".to_vec(),
            )]
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect(),
        );

        let volume = Volume::parse(&volume_bytes).unwrap();
        assert_eq!(
            volume.header.top_level,
            vec![FsEntry {
                fs_type: FsEntryType::Dir,
                text: Cow::Borrowed("a"),
                offset_start: 33,
                offset_end: 66,
            }]
        );

        let mut volumes = IndexMap::new();
        volumes.insert("atom".to_string(), volume);

        let atom_volume_bytes = Volume::serialize_atoms(
            [(DirOrFile::File("path/to/a".into()), b"".to_vec())]
                .iter()
                .map(|(a, b)| (a.clone(), b.clone()))
                .collect(),
        );

        let file = WebC {
            version: 1,
            checksum: None,
            signature: None,
            manifest: Manifest::default(),
            atoms: Volume::parse(&atom_volume_bytes).unwrap(),
            volumes,
        };

        assert_eq!(
            file.get_file(&file.get_package_name(), "/a/b/c/test.txt"),
            Ok(&b"hello"[..])
        );
    }

    #[test]
    fn test_walk_volume() {
        let volume = Volume::serialize_files({
            let mut map = BTreeMap::new();
            map.insert(
                DirOrFile::File(Path::new("test.txt").to_path_buf()),
                Vec::new(),
            );
            map.insert(DirOrFile::Dir(Path::new("a").to_path_buf()), Vec::new());
            map.insert(
                DirOrFile::File(Path::new("a/tmp2.txt").to_path_buf()),
                Vec::new(),
            );
            map
        });
        let volume = Volume::parse(&volume).unwrap();
        let files = volume.walk().collect::<Vec<_>>();

        assert_eq!(
            files,
            vec![
                DirOrFile::File(Path::new("test.txt").to_path_buf()),
                DirOrFile::Dir(Path::new("a").to_path_buf()),
                DirOrFile::File(Path::new("a/tmp2.txt").to_path_buf()),
            ]
        )
    }

    #[test]
    fn test_serialize_deserialize_volumes() {
        let mut volumes = IndexMap::new();

        let volume_a_bytes = Volume::serialize_files(
            [(
                DirOrFile::File(Path::new("test.txt").to_path_buf()),
                b"hello".to_vec(),
            )]
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect(),
        );
        let volume_b_bytes = Volume::serialize_files(
            [(
                DirOrFile::File(Path::new("test2.txt").to_path_buf()),
                b"hello2".to_vec(),
            )]
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect(),
        );

        volumes.insert("a".to_string(), Volume::parse(&volume_a_bytes).unwrap());
        volumes.insert("b".to_string(), Volume::parse(&volume_b_bytes).unwrap());
        let file = WebC {
            version: 1,
            checksum: None,
            signature: None,
            manifest: Manifest::default(),
            atoms: Volume::parse(&volume_b_bytes).unwrap(),
            volumes,
        };

        let volume_serialized = file.get_volumes_as_fileblock();
        let volumes_parsed = WebC::parse_volumes_from_fileblock(&volume_serialized).unwrap();
        assert_eq!(volumes_parsed["a"].get_file("test.txt"), Ok(&b"hello"[..]));
    }
}
