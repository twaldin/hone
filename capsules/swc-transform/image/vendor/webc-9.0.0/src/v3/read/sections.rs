use std::ops::Range;

use bytes::Buf;
use shared_buffer::OwnedBuffer;

use crate::{
    metadata::Manifest,
    readable_bytes::readable_bytes,
    v3::{
        read::{
            dir_entry::{DirEntryError, FileEntry},
            volume_header::{FileMetadata, HeaderEntry, VolumeHeader, VolumeHeaderError},
            Directory,
        },
        Index, Span, Tag,
    },
    PathSegmentError, PathSegments, ToPathSegments,
};

/// Errors that may occur while parsing a [`Section`].
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum SectionError {
    #[error("The tag doesn't indicate the start of a section")]
    UnsupportedSection,
    #[error("Unable to parse the section as CBOR")]
    Cbor(#[from] ciborium::value::Error),
    #[error(
        "Unable to parse \"{}\" as a UTF8 volume name",
        name.escape_ascii(),
    )]
    InvalidVolumeName {
        error: std::str::Utf8Error,
        name: OwnedBuffer,
    },
    #[error("Invalid section length, expected at least {expected} bytes but only {available} were available")]
    InvalidSectionLength { expected: usize, available: usize },
    #[error(transparent)]
    Overflow(#[from] std::num::TryFromIntError),
}

/// The different sections in a webc file.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum Section {
    Index(IndexSection),
    Manifest(ManifestSection),
    Atoms(AtomsSection),
    Volume(VolumeSection),
}

impl Section {
    pub fn parse(
        tag: u8,
        hash: Option<[u8; 32]>,
        data: OwnedBuffer,
    ) -> Result<Section, SectionError> {
        let tag = Tag::from_u8(tag).ok_or(SectionError::UnsupportedSection)?;

        match tag {
            Tag::Index => Ok(IndexSection(data).into()),
            Tag::Manifest => Ok(ManifestSection {
                buffer: data,
                hash: hash.expect("hash must be present for the manifest section"),
            }
            .into()),
            Tag::Atoms => {
                let atoms = AtomsSection::parse(
                    data,
                    hash.expect("hash must be present for the atoms section"),
                )?;
                Ok(atoms.into())
            }
            Tag::Volume => {
                let volume = VolumeSection::parse(
                    data,
                    hash.expect("hash must be present for the volumes section"),
                )?;
                Ok(volume.into())
            }
            _ => Err(SectionError::UnsupportedSection),
        }
    }

    pub fn as_index(&self) -> Option<&IndexSection> {
        if let Self::Index(v) = self {
            Some(v)
        } else {
            None
        }
    }

    pub fn as_manifest(&self) -> Option<&ManifestSection> {
        if let Self::Manifest(v) = self {
            Some(v)
        } else {
            None
        }
    }

    pub fn as_atoms(&self) -> Option<&AtomsSection> {
        if let Self::Atoms(v) = self {
            Some(v)
        } else {
            None
        }
    }

    pub fn as_volume(&self) -> Option<&VolumeSection> {
        if let Self::Volume(v) = self {
            Some(v)
        } else {
            None
        }
    }
}

impl From<IndexSection> for Section {
    fn from(value: IndexSection) -> Self {
        Section::Index(value)
    }
}

impl TryFrom<Section> for IndexSection {
    type Error = SectionConversionError;

    fn try_from(value: Section) -> Result<Self, Self::Error> {
        match value {
            Section::Index(section) => Ok(section),
            _ => Err(SectionConversionError),
        }
    }
}

impl From<ManifestSection> for Section {
    fn from(value: ManifestSection) -> Self {
        Section::Manifest(value)
    }
}

impl TryFrom<Section> for ManifestSection {
    type Error = SectionConversionError;

    fn try_from(value: Section) -> Result<Self, Self::Error> {
        match value {
            Section::Manifest(section) => Ok(section),
            _ => Err(SectionConversionError),
        }
    }
}

impl From<AtomsSection> for Section {
    fn from(value: AtomsSection) -> Self {
        Section::Atoms(value)
    }
}

impl TryFrom<Section> for AtomsSection {
    type Error = SectionConversionError;

    fn try_from(value: Section) -> Result<Self, Self::Error> {
        match value {
            Section::Atoms(section) => Ok(section),
            _ => Err(SectionConversionError),
        }
    }
}

impl From<VolumeSection> for Section {
    fn from(value: VolumeSection) -> Self {
        Section::Volume(value)
    }
}

impl TryFrom<Section> for VolumeSection {
    type Error = SectionConversionError;

    fn try_from(value: Section) -> Result<Self, Self::Error> {
        match value {
            Section::Volume(section) => Ok(section),
            _ => Err(SectionConversionError),
        }
    }
}

/// The error type returned when [`TryFrom`] can't convert a [`Section`] to the
/// desired type.
#[derive(Debug, Copy, Clone, PartialEq, thiserror::Error)]
#[error("Unable to convert the section to the desired type")]
pub struct SectionConversionError;

fn length_delimited_section(
    mut buffer: OwnedBuffer,
) -> Result<(OwnedBuffer, OwnedBuffer), SectionError> {
    if buffer.len() < std::mem::size_of::<u64>() {
        return Err(SectionError::InvalidSectionLength {
            expected: std::mem::size_of::<u64>(),
            available: buffer.len(),
        });
    }
    let length: usize = buffer.get_u64_le().try_into()?;

    if buffer.len() < length {
        return Err(SectionError::InvalidSectionLength {
            expected: length,
            available: buffer.len(),
        });
    }
    let head = buffer.slice(..length);
    buffer.advance(length);

    Ok((head, buffer))
}

/// A section containing the file's [`Index`].
#[derive(Clone, PartialEq)]
pub struct IndexSection(OwnedBuffer);

impl IndexSection {
    /// Lazily parse the section into an [`Index`].
    pub fn index(&self) -> Result<Index, ciborium::de::Error<std::io::Error>> {
        // Note: we need to add some special handling for the index section because
        // it may or may not contain trailing padding bytes.
        let index = ciborium::de::from_reader(self.0.as_slice())?;
        // Note: explicitly don't call the de.end() method.
        Ok(index)
    }
}

impl std::fmt::Debug for IndexSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("IndexSection")
            .field(&readable_bytes(&self.0))
            .finish()
    }
}

/// A section containing the file's [`Manifest`].
#[derive(Clone, PartialEq)]
pub struct ManifestSection {
    buffer: OwnedBuffer,
    hash: [u8; 32],
}

impl ManifestSection {
    /// Get a reference to the bytes this section contains.
    pub fn bytes(&self) -> &OwnedBuffer {
        &self.buffer
    }

    /// Deserialize into the canonical [`Manifest`] format.
    ///
    /// This is just shorthand for calling [`ManifestSection::deserialize()`]
    /// with the right types.
    pub fn manifest(&self) -> Result<Manifest, ciborium::de::Error<std::io::Error>> {
        self.deserialize()
    }

    /// Deserialize the manifest section into a custom type.
    pub fn deserialize<T>(&self) -> Result<T, ciborium::de::Error<std::io::Error>>
    where
        for<'a> T: serde::Deserialize<'a>,
    {
        ciborium::from_reader(self.buffer.as_slice())
    }
}

impl std::fmt::Debug for ManifestSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ManifestSection")
            .field(&readable_bytes(&self.buffer))
            .finish()
    }
}

/// A section containing the atoms volume.
#[derive(Clone, PartialEq)]
pub struct AtomsSection {
    hash: [u8; 32],
    header: OwnedBuffer,
    data: OwnedBuffer,
    data_offset: usize,
}

impl AtomsSection {
    fn parse(buffer: OwnedBuffer, hash: [u8; 32]) -> Result<Self, SectionError> {
        const OFFSET_INTO_VOLUME: usize =
            std::mem::size_of::<u8>() + 32 + std::mem::size_of::<u64>();
        let initial_length = buffer.len();

        let (header, rest) = length_delimited_section(buffer)?;

        let (data, rest) = length_delimited_section(rest)?;
        let data_offset = OFFSET_INTO_VOLUME + initial_length - rest.len() - data.len();

        Ok(AtomsSection {
            header,
            data,
            data_offset,
            hash,
        })
    }

    pub fn get_hash(&self) -> &[u8; 32] {
        &self.hash
    }

    pub fn get_atom(&self, atom_name: &str) -> Result<(OwnedBuffer, [u8; 32]), LookupError> {
        lookup_file(self.header(), &self.data, [atom_name])
    }

    pub fn get_atom_with_offset(
        &self,
        atom_name: &str,
    ) -> Result<(OwnedBuffer, [u8; 32]), LookupError> {
        lookup_file(self.header(), &self.data, [atom_name])
    }

    /// Iterate over all the atoms in this [`AtomsSection`].
    pub fn iter(
        &self,
    ) -> impl Iterator<Item = Result<(&str, [u8; 32], OwnedBuffer), DirEntryError>> {
        self.iter_with_offsets()
            .map(|result| result.map(|(name, hash, data, _)| (name, hash, data)))
    }

    /// Iterate over all the atoms in this [`AtomsSection`], including their
    /// offsets relative to the start of the volume.
    pub fn iter_with_offsets(
        &self,
    ) -> impl Iterator<Item = Result<(&str, [u8; 32], OwnedBuffer, Span), DirEntryError>> {
        let data_offset = self.data_offset;

        self.iter_entries().map(move |result| {
            result
                .map_err(DirEntryError::from)
                .and_then(|(name, hash, meta)| {
                    let entry = FileEntry::from_metadata(meta, data_offset, self.data.clone())?;
                    let data = entry.bytes().clone();
                    let span = Span::new(
                        self.data_offset + meta.start_offset,
                        meta.end_offset - meta.start_offset,
                    );
                    Ok((name, hash, data, span))
                })
        })
    }

    fn iter_entries(
        &self,
    ) -> impl Iterator<Item = Result<(&str, [u8; 32], FileMetadata), VolumeHeaderError>> {
        let header = self.header();
        FallibleIterator::new(header.root_directory().map(|dir| dir.entries())).filter_map(
            |result| match result {
                Ok((name, hash, HeaderEntry::File(file))) => Some(Ok((name, hash, file))),
                Ok(_) => None,
                Err(e) => Some(Err(e)),
            },
        )
    }

    /// The lazily parsed volume header.
    pub(crate) fn header(&self) -> VolumeHeader<'_> {
        VolumeHeader::new(&self.header)
    }
}

impl std::fmt::Debug for AtomsSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let AtomsSection {
            header,
            data,
            data_offset,
            hash,
        } = self;
        f.debug_struct("AtomsSection")
            .field("header", &readable_bytes(header))
            .field("data", &readable_bytes(data))
            .field("data_offset", data_offset)
            .field("hash", &hash)
            .finish()
    }
}

pub(crate) enum FallibleIterator<I, T, E>
where
    I: Iterator<Item = Result<T, E>>,
{
    Ok(I),
    Err(Option<E>),
}

impl<I, T, E> FallibleIterator<I, T, E>
where
    I: Iterator<Item = Result<T, E>>,
{
    pub(crate) fn new(result: Result<I, E>) -> Self {
        match result {
            Ok(iter) => FallibleIterator::Ok(iter),
            Err(err) => FallibleIterator::Err(Some(err)),
        }
    }
}

impl<I, T, E> Iterator for FallibleIterator<I, T, E>
where
    I: Iterator<Item = Result<T, E>>,
{
    type Item = I::Item;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            FallibleIterator::Ok(iter) => iter.next(),
            FallibleIterator::Err(e) => e.take().map(Err),
        }
    }
}

/// A volume section containing a directory tree.
#[derive(Clone, PartialEq)]
pub struct VolumeSection {
    hash: [u8; 32],
    name: String,
    header: OwnedBuffer,
    data: OwnedBuffer,
    data_offset: usize,
}

impl VolumeSection {
    /// Parse the payload of a volume section, starting after the initial tag
    /// and length.
    fn parse(buffer: OwnedBuffer, hash: [u8; 32]) -> Result<Self, SectionError> {
        const OFFSET_INTO_VOLUME: usize =
            std::mem::size_of::<Tag>() + 32 + std::mem::size_of::<u64>();
        let initial_length = buffer.len();

        let (name, rest) = length_delimited_section(buffer)?;
        let name = std::str::from_utf8(&name)
            .map(|s| s.to_string())
            .map_err(|error| SectionError::InvalidVolumeName { error, name })?;

        let (header, rest) = length_delimited_section(rest)?;

        let (data, rest) = length_delimited_section(rest)?;
        let data_offset = OFFSET_INTO_VOLUME + initial_length - rest.len() - data.len();

        Ok(VolumeSection {
            hash,
            name,
            header,
            data,
            data_offset,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The lazily parsed volume header.
    pub(crate) fn header(&self) -> VolumeHeader<'_> {
        VolumeHeader::new(&self.header)
    }

    pub fn lookup_file(
        &self,
        path: impl ToPathSegments,
    ) -> Result<(OwnedBuffer, [u8; 32]), LookupError> {
        lookup_file(self.header(), &self.data, path)
    }

    pub fn root(&self) -> Result<Directory<'_>, VolumeHeaderError> {
        self.header()
            .root_directory()
            .map(|root| Directory::new(root, self.data_offset, self.data.clone()))
    }
}

impl std::fmt::Debug for VolumeSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let VolumeSection {
            name,
            header,
            data,
            data_offset,
            hash,
        } = self;

        f.debug_struct("VolumeSection")
            .field("name", &name)
            .field("header", &readable_bytes(header))
            .field("data", &readable_bytes(data))
            .field("data_offset", data_offset)
            .field("hash", &hash)
            .finish()
    }
}

fn lookup_file(
    header: VolumeHeader<'_>,
    data: &OwnedBuffer,
    path: impl ToPathSegments,
) -> Result<(OwnedBuffer, [u8; 32]), LookupError> {
    let path_segments = path.to_path_segments()?;

    match header.find(&path_segments)? {
        Some((HeaderEntry::File(offsets), hash)) => {
            let range = offsets.start_offset..offsets.end_offset;

            if range.end > data.len() {
                return Err(LookupError::InvalidItemLocation {
                    path: path_segments,
                    range,
                });
            }

            Ok((data.slice(range), hash))
        }
        Some((HeaderEntry::Directory(_), _)) => Err(LookupError::IsADirectory),
        None => Err(LookupError::NotFound),
    }
}

/// Errors that may occur while looking up an item in a volume.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum LookupError {
    #[error("Is a directory")]
    IsADirectory,
    #[error("Not found")]
    NotFound,
    #[error("Unable to parse the volume header")]
    Header(#[from] VolumeHeaderError),
    #[error("Invalid path")]
    InvalidPath(#[from] PathSegmentError),
    #[error("The metadata for \"{path}\" says the file is at {range:?}, which is out of bounds")]
    InvalidItemLocation {
        path: PathSegments,
        range: Range<usize>,
    },
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use sha2::Digest;

    use crate::{
        utils::{length_field, sha256},
        v3::{Checksum, IndexEntry, Signature, Span, Timestamps},
    };

    use super::*;

    #[test]
    fn read_an_index_section() {
        let index = Index {
            manifest: IndexEntry {
                span: Span::new(1, 2),
                checksum: Checksum::none(),
            },
            atoms: IndexEntry {
                span: Span::new(3, 4),
                checksum: Checksum::sha256([0xaa; 32]),
            },
            volumes: BTreeMap::new(),
            signature: Signature::none(),
        };
        let mut bytes = vec![];
        ciborium::into_writer(&index, &mut bytes).unwrap();
        let bytes: OwnedBuffer = bytes.into();

        let section = Section::parse(Tag::Index.as_u8(), None, bytes.clone()).unwrap();

        assert_eq!(section, Section::Index(IndexSection(bytes)));
        assert_eq!(section.as_index().unwrap().index().unwrap(), index);
    }

    #[test]
    fn read_the_kitchen_sink_volume_section() {
        let xyz_txt = [0xaa; 10];
        let file1_txt = [0xbb; 5];
        let file2_txt = [0xcc; 8];
        let file3_txt = [0xdd; 2];

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

        let raw = bytes! {
            // ==== Name ====
            length_field("volume"),
            "volume",

            // ==== Header section ====
            // header length
            1039_u64.to_le_bytes(),

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

            // ==== Data section ====
            // data length
            25_u64.to_le_bytes(),
            // Raw file data
            file1_txt,
            xyz_txt,
            file2_txt,
            file3_txt,
        };

        let volume = VolumeSection::parse(raw.into(), [0u8; 32]).unwrap();

        let root_items: Vec<_> = volume
            .root()
            .unwrap()
            .entries()
            .filter_map(|result| result.ok())
            .map(|(name, hash, _)| (name, hash))
            .collect();
        assert_eq!(root_items, &[("a", a_hash), ("file3.txt", file3_hash)]);

        let (file, hash) = volume.lookup_file(["a", "b", "file1.txt"]).unwrap();
        assert_eq!((file.as_ref(), hash), (file1_txt.as_slice(), file1_hash),);

        let (file, hash) = volume.lookup_file(["a", "c", "file2.txt"]).unwrap();
        assert_eq!((file.as_ref(), hash), (file2_txt.as_slice(), file2_hash),);

        let (file, hash) = volume.lookup_file(["file3.txt"]).unwrap();
        assert_eq!((file.as_ref(), hash), (file3_txt.as_slice(), file3_hash),);

        let (file, hash) = volume.lookup_file(["a", "b", "xyz.txt"]).unwrap();
        assert_eq!((file.as_ref(), hash), (xyz_txt.as_slice(), xyz_hash),);
    }
}
