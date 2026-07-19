use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek},
    path::Path,
    sync::OnceLock,
};

use bytes::Buf;
use sha2::Digest;
use shared_buffer::OwnedBuffer;

use crate::{
    metadata::Manifest,
    v3::{
        read::{
            dir_entry::DirEntryError, scanner::InvalidSize, sections::SectionConversionError,
            AtomsSection, ManifestSection, Section, SectionError, VolumeSection,
        },
        Index, Span, Tag,
    },
    DetectError, Magic, Version,
};

/// A reader for owned data that is already in memory.
#[derive(Debug, Clone, PartialEq)]
pub struct OwnedReader {
    buffer: OwnedBuffer,
    index: Index,
    manifest: Manifest,
    atoms_hash: [u8; 32],
    atoms: BTreeMap<String, ([u8; 32], OwnedBuffer)>,
    hash: OnceLock<[u8; 32]>,
}

impl OwnedReader {
    pub fn parse(webc: impl Into<OwnedBuffer>) -> Result<Self, OwnedReaderError> {
        let webc: OwnedBuffer = webc.into();

        // Make sure we're actually reading a WEBC file we can support
        let version = crate::detect(webc.clone().reader())?;
        if version != Version::V3 {
            return Err(OwnedReaderError::UnsupportedVersion(version));
        }
        let index = read_index(webc.clone())?;

        // We extract the manifest and atoms eagerly because that's what most
        // people will want.
        let manifest =
            parse_section(&webc, index.manifest.span).and_then(|section: ManifestSection| {
                section.manifest().map_err(OwnedReaderError::Manifest)
            })?;
        let atoms_section: AtomsSection = parse_section(&webc, index.atoms.span)?;
        let atoms = atoms_section
            .iter()
            .map(|result| result.map(|(s, h, b)| (s.to_string(), (h, b))))
            .collect::<Result<BTreeMap<String, ([u8; 32], OwnedBuffer)>, DirEntryError>>()
            .map_err(OwnedReaderError::Atoms)?;

        Ok(OwnedReader {
            buffer: webc,
            index,
            atoms_hash: *atoms_section.get_hash(),
            atoms,
            manifest,
            hash: OnceLock::new(),
        })
    }

    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, OwnedReaderError> {
        let buffer = OwnedBuffer::mmap(path.as_ref())?;
        OwnedReader::parse(buffer)
    }

    /// Try to parse a [`File`] into an [`OwnedReader`].
    ///
    /// This will try to memory-map the file if supported by the OS, otherwise
    /// it will read the entire file into memory.
    pub fn from_file(mut file: File) -> Result<Self, OwnedReaderError> {
        if let Ok(buffer) = OwnedBuffer::from_file(&file) {
            return OwnedReader::parse(buffer);
        }

        // Fall back to the allocating version
        file.rewind().map_err(OwnedReaderError::Io)?;
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)
            .map_err(OwnedReaderError::Io)?;

        OwnedReader::parse(contents)
    }

    pub fn webc_hash(&self) -> Option<[u8; 32]> {
        Some(
            *self
                .hash
                .get_or_init(|| sha2::Sha256::digest(self.buffer.as_slice()).into()),
        )
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn index(&self) -> &Index {
        &self.index
    }

    pub fn atoms_hash(&self) -> [u8; 32] {
        self.atoms_hash
    }

    pub fn atom_names(&self) -> impl Iterator<Item = &str> + '_ {
        self.atoms.keys().map(|s| s.as_str())
    }

    pub fn iter_atoms(&self) -> impl Iterator<Item = (&str, [u8; 32], &OwnedBuffer)> + '_ {
        self.atoms.iter().map(|(s, (h, b))| (s.as_str(), *h, b))
    }

    pub fn get_atom(&self, name: &str) -> Option<&([u8; 32], OwnedBuffer)> {
        self.atoms.get(name)
    }

    pub fn volume_names(&self) -> impl Iterator<Item = &str> + '_ {
        self.index.volumes.keys().map(|s| s.as_str())
    }

    pub fn iter_volumes(
        &self,
    ) -> impl Iterator<Item = Result<(&str, VolumeSection), OwnedReaderError>> {
        self.index.volumes.iter().map(|(name, entry)| {
            let volume: VolumeSection = parse_section(&self.buffer, entry.span)?;
            Ok((name.as_str(), volume))
        })
    }

    pub fn get_volume(&self, name: &str) -> Result<VolumeSection, OwnedReaderError> {
        let entry = self
            .index
            .volumes
            .get(name)
            .ok_or_else(|| OwnedReaderError::NoSuchVolume {
                name: name.to_string(),
            })?;

        parse_section(&self.buffer, entry.span)
    }
}

fn parse_section<T>(buffer: &OwnedBuffer, span: Span) -> Result<T, OwnedReaderError>
where
    T: TryFrom<Section, Error = SectionConversionError>,
{
    let (tag, hash, data) = get_section(buffer, span)?;

    let section = Section::parse(tag, Some(hash), data.clone())
        .map_err(|error| OwnedReaderError::Section { error, tag, data })?;

    T::try_from(section).map_err(OwnedReaderError::from)
}

fn get_section(
    buffer: &OwnedBuffer,
    span: Span,
) -> Result<(u8, [u8; 32], OwnedBuffer), OwnedReaderError> {
    get(buffer, span).and_then(read_raw_section)
}

fn get(buffer: &OwnedBuffer, span: Span) -> Result<OwnedBuffer, OwnedReaderError> {
    if buffer.len() < span.end() {
        Err(OwnedReaderError::IndexOutOfBounds {
            offset: span.end(),
            bytes_available: buffer.len(),
        })
    } else {
        Ok(buffer.slice(span.start..span.end()))
    }
}

fn read_raw_index_section(mut buffer: OwnedBuffer) -> Result<(u8, OwnedBuffer), OwnedReaderError> {
    const TAG_AND_LEN: usize = std::mem::size_of::<u8>() + std::mem::size_of::<u64>();

    if buffer.len() < TAG_AND_LEN {
        return Err(OwnedReaderError::Io(std::io::Error::from(
            std::io::ErrorKind::UnexpectedEof,
        )));
    }

    let tag = buffer.get_u8();
    let length: usize = buffer.get_u64_le().try_into()?;

    if buffer.len() < length {
        return Err(OwnedReaderError::Io(std::io::Error::from(
            std::io::ErrorKind::UnexpectedEof,
        )));
    }

    let data = buffer.slice(..length);
    buffer.advance(length);

    Ok((tag, data))
}

fn read_raw_section(
    mut buffer: OwnedBuffer,
) -> Result<(u8, [u8; 32], OwnedBuffer), OwnedReaderError> {
    const TAG_AND_LEN: usize = std::mem::size_of::<u8>() + 32 + std::mem::size_of::<u64>();

    if buffer.len() < TAG_AND_LEN {
        return Err(OwnedReaderError::Io(std::io::Error::from(
            std::io::ErrorKind::UnexpectedEof,
        )));
    }

    let tag = buffer.get_u8();
    let mut hash = [0u8; 32];
    buffer.copy_to_slice(&mut hash);
    let length: usize = buffer.get_u64_le().try_into()?;

    if buffer.len() < length {
        return Err(OwnedReaderError::Io(std::io::Error::from(
            std::io::ErrorKind::UnexpectedEof,
        )));
    }

    let data = buffer.slice(..length);
    buffer.advance(length);

    Ok((tag, hash, data))
}

fn read_index(mut webc: OwnedBuffer) -> Result<Index, OwnedReaderError> {
    // Skip the magic bytes and version number
    const HEADER_LENGTH: usize = std::mem::size_of::<Magic>() + std::mem::size_of::<Version>();
    webc.advance(HEADER_LENGTH);

    let (tag, data) = read_raw_index_section(webc)?;

    match Section::parse(tag, None, data.clone()) {
        Ok(Section::Index(index_reader)) => {
            let index = index_reader.index().map_err(OwnedReaderError::Index)?;
            Ok(index)
        }
        Ok(_) => Err(OwnedReaderError::UnexpectedSection {
            expected_tag: Tag::Index,
            actual_tag: tag,
            offset: HEADER_LENGTH,
        }),
        Err(error) => Err(OwnedReaderError::Section { error, tag, data }),
    }
}

/// Errors that may be emitted by [`OwnedReader`].
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum OwnedReaderError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("Invalid magic bytes, {}", _0.escape_ascii())]
    InvalidMagic(Magic),
    #[error("The version, {_0}, isn't supported")]
    UnsupportedVersion(Version),
    #[error("Expected to find a {expected_tag} at offset {offset:#x}, but found a \"{}\"", Tag::display(*actual_tag))]
    UnexpectedSection {
        expected_tag: Tag,
        actual_tag: u8,
        offset: usize,
    },
    #[error(
        "Tried to access memory at offset {offset}, but only {bytes_available} bytes are available"
    )]
    IndexOutOfBounds {
        offset: usize,
        bytes_available: usize,
    },
    #[error("Unable to parse the index as CBOR")]
    Index(ciborium::de::Error<std::io::Error>),
    #[error("Unable to parse the manifest as CBOR")]
    Manifest(ciborium::de::Error<std::io::Error>),
    #[error("Unable to decode a section")]
    Section {
        #[source]
        error: SectionError,
        tag: u8,
        data: OwnedBuffer,
    },
    #[error("Found the wrong section")]
    IncorrectSection(#[from] SectionConversionError),
    #[error("Volume not found: \"{name}\"")]
    NoSuchVolume { name: String },
    #[error("Unable to determine the atoms")]
    Atoms(DirEntryError),
    #[error("Unable to detect the WEBC file's version number")]
    Detect(#[from] DetectError),
    #[error(transparent)]
    Mmap(#[from] shared_buffer::MmapError),
    #[error(transparent)]
    IntegerConversion(#[from] std::num::TryFromIntError),
}

impl From<InvalidSize> for OwnedReaderError {
    fn from(value: InvalidSize) -> Self {
        let InvalidSize { expected, actual } = value;
        OwnedReaderError::IndexOutOfBounds {
            offset: expected,
            bytes_available: actual,
        }
    }
}
