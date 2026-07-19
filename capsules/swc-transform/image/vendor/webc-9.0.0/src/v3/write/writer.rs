use std::{collections::BTreeMap, io::Write};

use bytes::{BufMut, Bytes, BytesMut};
use once_cell::sync::Lazy;
use sha2::Digest;

use crate::{
    metadata::Manifest,
    v3::{
        signature::SignatureState,
        write::{volumes::VolumeParts, DirEntry, Directory, FileEntry},
        Checksum, ChecksumAlgorithm, Index, IndexEntry, Signature, SignatureAlgorithm,
        SignatureError, Span, Tag, Timestamps,
    },
    PathSegment, Version,
};

static HEADER: Lazy<BytesMut> = Lazy::new(|| {
    let mut header = BytesMut::with_capacity(8);
    header.extend_from_slice(&crate::MAGIC);
    header.extend_from_slice(&Version::V3.0);

    header
});

/// A serializer for the WEBC format.
#[derive(Debug)]
#[must_use = "A Writer is a state machine and should be run to completion"]
pub struct Writer<S> {
    checksum_algorithm: ChecksumAlgorithm,
    state: S,
}

impl Writer<WritingManifest> {
    /// Create a new [`Writer`] in its initial state.
    pub fn new(checksum_algorithm: ChecksumAlgorithm) -> Self {
        Writer {
            state: WritingManifest {
                header: HEADER.clone(),
            },
            checksum_algorithm,
        }
    }
}

impl Default for Writer<WritingManifest> {
    fn default() -> Self {
        Writer::new(ChecksumAlgorithm::Sha256)
    }
}

impl<S> Writer<S> {
    /// Transition the writer from one state to the next.
    fn map_state<S2>(self, map: impl FnOnce(S) -> S2) -> Writer<S2> {
        let Writer {
            state,
            checksum_algorithm,
        } = self;
        Writer {
            state: map(state),
            checksum_algorithm,
        }
    }
}

impl Writer<WritingManifest> {
    /// Write a [`Manifest`] to the manifest section, transitioning from the
    /// [`WritingManifest`] state to [`WritingAtoms`].
    pub fn write_manifest(self, manifest: &Manifest) -> Result<Writer<WritingAtoms>, WriteError> {
        self.write_cbor_manifest(manifest)
    }

    /// Serialize an arbitrary object to CBOR and write it to the manifest
    /// section.
    ///
    /// Most users should prefer to use [`Writer::write_manifest()`], although
    /// this method might be useful in niche circumstances where you have
    /// your own, specialized `Manifest` type.
    pub fn write_cbor_manifest(
        self,
        manifest: &impl serde::Serialize,
    ) -> Result<Writer<WritingAtoms>, WriteError> {
        let mut data = vec![];
        ciborium::into_writer(manifest, &mut data).unwrap();
        Ok(self.write_raw_manifest(data))
    }

    /// Write some bytes to the manifest section.
    ///
    /// This assumes the provided bytes encode a valid CBOR object roughly
    /// following the [`Manifest`] structure.
    pub fn write_raw_manifest(self, manifest: impl Into<Bytes>) -> Writer<WritingAtoms> {
        let manifest = Section::new(Tag::Manifest, manifest, self.checksum_algorithm);

        self.map_state(|state| state.with_manifest(manifest))
    }
}

impl Writer<WritingAtoms> {
    /// Write some atoms to the atoms section of the file, transitioning from
    /// the [`WritingAtoms`] state to [`WritingVolumes`].
    pub fn write_atoms(
        self,
        atoms: BTreeMap<PathSegment, FileEntry<'_>>,
    ) -> Result<Writer<WritingVolumes>, WriteError> {
        let children = atoms
            .into_iter()
            .map(|(k, v)| (k, DirEntry::File(v)))
            .collect();

        // NOTE: atoms do not have timestamps since they are not a directory on disk, so we use default timestamps.
        let atoms = VolumeParts::serialize(Directory {
            children,
            timestamps: Timestamps::default(),
        })?
        .atoms();
        let section = Section::new(Tag::Atoms, atoms, self.checksum_algorithm);

        Ok(self.map_state(|state| state.with_atoms(section)))
    }
}

impl Writer<WritingVolumes> {
    /// Write a volume to the file.
    pub fn write_volume(&mut self, name: &str, volume: Directory<'_>) -> Result<(), WriteError> {
        let volume = VolumeParts::serialize(volume)?.volume(name);
        let section = Section::new(Tag::Volume, volume, self.checksum_algorithm);

        if let Some(_previous) = self.state.volumes.insert(name.to_string(), section) {
            return Err(WriteError::DuplicateVolume(name.to_string()));
        }

        Ok(())
    }

    /// Add a volume to the file.
    pub fn with_volume(mut self, name: &str, volume: Directory<'_>) -> Result<Self, WriteError> {
        self.write_volume(name, volume)?;
        Ok(self)
    }

    /// Finish writing volumes and get the final WEBC file.
    pub fn finish(self, signature_algorithm: SignatureAlgorithm) -> Result<Bytes, WriteError> {
        let Writer { state, .. } = self;

        let sections = final_layout(&state, signature_algorithm, self.checksum_algorithm)?;
        let mut buffer =
            BytesMut::with_capacity(sections.iter().map(|s| s.serialized_length()).sum());

        buffer.extend_from_slice(&state.header);

        let mut hasher = sha2::Sha256::new();
        for section in &sections {
            section.write_to(&mut buffer);

            if let Some(hash) = section.hash {
                hasher.update(hash);
            }
        }

        Ok(buffer.freeze())
    }
}

/// Figure out where each section should be placed and start building up the
/// [`Index`] so we can find the sections in constant time.
///
/// Sections in a WEBC file are laid out in the following order:
///
/// - magic byte & version number (not really a section, but anyways...)
/// - index
/// - manifest
/// - atoms
/// - volumes...
///
/// Note that we've got a bit of a chicken-and-egg situation going on. The
/// serialized [`Index`] section goes **before** all other sections, yet the
/// index wants to know the offset of each section from the start of the file.
///
/// We deal with this by calculating offsets relative to the end of the index
/// (i.e. the start of the manifest) in
/// [`calculate_layout_and_initial_index()`], then we get a rough idea of the
/// index's serialized lengths and update offsets accordingly.
fn final_layout(
    state: &WritingVolumes,
    signature_algorithm: SignatureAlgorithm,
    checksum_algorithm: ChecksumAlgorithm,
) -> Result<Vec<Section>, WriteError> {
    let (initial_index, mut sections) =
        calculate_layout_and_initial_index(state, signature_algorithm)?;

    let estimated_index_section_length =
        std::mem::size_of::<Tag>() + std::mem::size_of::<u64>() + cbor_len(&initial_index)?;

    // This fudge factor stuff is kinda hacky, but it's needed because integers
    // are variable length in CBOR and applying our offsets may accidentally
    // cause one integer to be long enough to require an extra byte. That would
    // make the entire index section larger, messing up all the offsets.
    //
    // To compensate for this, we deliberately add some padding to the end.
    let fudge_factor = estimated_index_section_length / 5;
    let allocated_index_section_length = estimated_index_section_length + fudge_factor;

    let offset_from_start = state.header.len()
        + allocated_index_section_length
        + std::mem::size_of::<Tag>()
        + std::mem::size_of::<u64>();
    let index: Index = initial_index.with_offset(offset_from_start);

    let mut serialized_index = vec![];
    ciborium::into_writer(&index, &mut serialized_index).unwrap();
    debug_assert!(
        serialized_index.len() < allocated_index_section_length,
        "Insufficient padding was allocated. Expected {} < {}. This is a bug.",
        serialized_index.len(),
        allocated_index_section_length
    );
    serialized_index.resize(allocated_index_section_length, 0);
    let index_section = Section::without_hash(Tag::Index, serialized_index, checksum_algorithm);

    sections.insert(0, index_section);

    Ok(sections)
}

fn cbor_len(value: &impl serde::Serialize) -> Result<usize, ciborium::value::Error> {
    struct CountingWriter {
        bytes_written: usize,
    }

    impl Write for CountingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.bytes_written += buf.len();
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut writer = CountingWriter { bytes_written: 0 };
    ciborium::into_writer(value, &mut writer).unwrap();

    Ok(writer.bytes_written)
}

fn calculate_layout_and_initial_index(
    state: &WritingVolumes,
    signature_algorithm: SignatureAlgorithm,
) -> Result<(Index, Vec<Section>), SignatureError> {
    let WritingVolumes {
        manifest,
        atoms,
        volumes,
        ..
    } = state;

    let mut layout = LayoutState {
        bytes_written: 0,
        sections: Vec::new(),
        signature_state: signature_algorithm.begin(),
    };

    // Note: Section data and checksums are reference-counted

    let manifest = layout.push(manifest.clone())?;
    let atoms = layout.push(atoms.clone())?;

    let mut volume_entries = BTreeMap::new();

    for (name, section) in volumes {
        let span = layout.push(section.clone())?;
        volume_entries.insert(name.clone(), span);
    }

    let (sections, signature) = layout.finish()?;

    let index = Index {
        manifest,
        atoms,
        volumes: volume_entries,
        signature,
    };

    Ok((index, sections))
}

/// Intermediate state used by the layout algorithm.
#[derive(Debug)]
struct LayoutState {
    bytes_written: usize,
    signature_state: SignatureState,
    sections: Vec<Section>,
}

impl LayoutState {
    fn push(&mut self, section: Section) -> Result<IndexEntry, SignatureError> {
        let checksum = section.checksum.clone();
        self.signature_state.update(&section)?;

        let start = self.bytes_written;
        self.bytes_written += section.serialized_length();
        let span = Span::new(start, self.bytes_written - start);

        self.sections.push(section);

        Ok(IndexEntry { span, checksum })
    }

    fn finish(self) -> Result<(Vec<Section>, Signature), SignatureError> {
        let LayoutState {
            signature_state,
            sections,
            ..
        } = self;
        let signature = signature_state.finish()?;
        Ok((sections, signature))
    }
}

/// The [`Writer`] is about to write the [`Manifest`] section.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub struct WritingManifest {
    header: BytesMut,
}

impl WritingManifest {
    fn with_manifest(self, manifest: Section) -> WritingAtoms {
        let WritingManifest { header } = self;
        WritingAtoms { manifest, header }
    }
}

/// The [`Writer`] is about to write the atoms section.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub struct WritingAtoms {
    header: BytesMut,
    manifest: Section,
}

impl WritingAtoms {
    fn with_atoms(self, atoms: Section) -> WritingVolumes {
        let WritingAtoms { header, manifest } = self;
        WritingVolumes {
            header,
            manifest,
            atoms,
            volumes: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct Section {
    pub(crate) tag: Tag,
    pub(crate) data: Bytes,
    pub(crate) hash: Option<[u8; 32]>,
    pub(crate) checksum: Checksum,
}

impl Section {
    pub(crate) fn new(tag: Tag, data: impl Into<Bytes>, checksum: ChecksumAlgorithm) -> Self {
        let data: Bytes = data.into();
        let checksum = checksum.calculate(&data);

        let hash = Some(sha2::Sha256::digest(&data).into());

        Section {
            tag,
            data,
            hash,
            checksum,
        }
    }

    pub(crate) fn without_hash(
        tag: Tag,
        data: impl Into<Bytes>,
        checksum: ChecksumAlgorithm,
    ) -> Self {
        let data: Bytes = data.into();
        let checksum = checksum.calculate(&data);

        Section {
            tag,
            data,
            hash: None,
            checksum,
        }
    }

    fn serialized_length(&self) -> usize {
        std::mem::size_of::<Tag>()
            + self.hash.map_or(0, |hash| hash.len())
            + std::mem::size_of::<u64>()
            + self.data.len()
    }

    pub(crate) fn write_to(&self, buffer: &mut BytesMut) {
        let Section {
            tag, data, hash, ..
        } = self;

        buffer.put_u8(tag.as_u8());
        if let Some(hash) = hash {
            buffer.extend_from_slice(hash.as_slice());
        }
        buffer.put_u64_le(data.len().try_into().unwrap());
        buffer.extend_from_slice(data);
    }
}

/// The [`Writer`] is writing volumes sections.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub struct WritingVolumes {
    header: BytesMut,
    manifest: Section,
    atoms: Section,
    volumes: BTreeMap<String, Section>,
}

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("Unable to calculate the signature")]
    Signature(#[from] SignatureError),
    #[error("Serializing to CBOR failed")]
    Cbor(#[from] ciborium::value::Error),
    #[error("Attempted to write multiple volumes with the name, \"{_0}\"")]
    DuplicateVolume(String),
}

#[cfg(test)]
mod tests {
    use crate::{
        utils::sha256,
        v3::{Checksum, ChecksumAlgorithm, Index, IndexEntry, Signature, Span},
    };

    use super::*;

    #[test]
    fn the_header_section_is_correct() {
        let Writer {
            state: WritingManifest { header },
            ..
        } = Writer::new(ChecksumAlgorithm::None);

        assert_bytes_eq!(
            header,
            bytes! {
                crate::MAGIC,
                Version::V3,
            }
        );
    }

    #[test]
    fn write_a_basic_manifest_section() {
        let writer = Writer {
            state: WritingManifest {
                header: HEADER.clone(),
            },
            checksum_algorithm: ChecksumAlgorithm::Sha256,
        };
        let manifest = Manifest {
            entrypoint: Some("python".to_string()),
            ..Default::default()
        };

        let Writer { state, .. } = writer.write_manifest(&manifest).unwrap();

        let mut expected = vec![];
        ciborium::into_writer(&manifest, &mut expected).unwrap();
        let hash: [u8; 32] = sha2::Sha256::digest(&expected).into();

        assert_eq!(
            state,
            WritingAtoms {
                header: HEADER.clone(),
                manifest: Section {
                    tag: Tag::Manifest,
                    checksum: ChecksumAlgorithm::Sha256.calculate(&expected),
                    data: expected.into(),
                    hash: Some(hash),
                }
            },
        )
    }

    #[test]
    fn the_atoms_section_is_a_kind_of_volume() {
        let manifest = Section::new(Tag::Manifest, Bytes::new(), ChecksumAlgorithm::None);
        let writer = Writer {
            state: WritingAtoms {
                header: HEADER.clone(),
                manifest: manifest.clone(),
            },
            checksum_algorithm: ChecksumAlgorithm::None,
        };

        let Writer { state, .. } = writer.write_atoms(BTreeMap::new()).unwrap();

        let empty_hash: [u8; 32] = sha2::Sha256::new().finalize().into();

        let expected = bytes! {
            // header section
            65_u64.to_le_bytes(),
            Tag::Directory,
            56_u64.to_le_bytes(),
            Timestamps::default(),
            empty_hash,
            // data section (empty)
            0_u64.to_le_bytes(),
        };

        let hash: [u8; 32] = sha2::Sha256::digest(&expected).into();

        assert_bytes_eq!(state.atoms.data, expected);
        assert_eq!(
            state,
            WritingVolumes {
                header: HEADER.clone(),
                manifest,
                atoms: Section {
                    tag: Tag::Atoms,
                    checksum: Checksum::none(),
                    data: expected,
                    hash: Some(hash),
                },
                volumes: BTreeMap::new(),
            }
        )
    }

    #[test]
    fn create_simple_webc_file() -> Result<(), Box<dyn std::error::Error>> {
        let manifest = Manifest::default();

        let mut writer = Writer::new(ChecksumAlgorithm::Sha256)
            .write_manifest(&manifest)?
            .write_atoms(BTreeMap::new())?;
        writer.write_volume("first", dir_map!("a" => b"Hello, World!"))?;
        let webc = writer.finish(SignatureAlgorithm::None)?;

        let mut data = vec![];
        ciborium::into_writer(&manifest, &mut data).unwrap();
        let manifest_hash: [u8; 32] = sha2::Sha256::digest(data).into();
        let manifest_section = bytes! {
            Tag::Manifest,
            manifest_hash,
            1_u64.to_le_bytes(),
            [0xa0],
        };

        // assert_bytes_eq!(manifest_hash, [0; 32]);

        let empty_hash: [u8; 32] = sha2::Sha256::new().finalize().into();

        let atoms_header_and_data = bytes! {
            // header section
            65_u64.to_le_bytes(),
            Tag::Directory,
            56_u64.to_le_bytes(),
            Timestamps::default(),
            empty_hash,
            // data section (empty)
            0_u64.to_le_bytes(),
        };

        let atoms_hash: [u8; 32] = sha2::Sha256::digest(&atoms_header_and_data).into();
        let atoms_section = bytes! {
            Tag::Atoms,
            atoms_hash,
            81_u64.to_le_bytes(),
            atoms_header_and_data,
        };

        let a_hash: [u8; 32] = sha2::Sha256::digest(b"Hello, World!").into();
        let dir_hash: [u8; 32] = sha2::Sha256::digest(a_hash).into();
        let volume_header_and_data = bytes! {
            // ==== Name ====
            5_u64.to_le_bytes(),
            "first",
            // ==== Header Section ====
            187_u64.to_le_bytes(),
            // ---- root directory ----
            Tag::Directory,
            105_u64.to_le_bytes(),
            Timestamps::default(),
            dir_hash,
            // first entry
            114_u64.to_le_bytes(),
            a_hash,
            1_u64.to_le_bytes(),
            "a",

            // ---- first item ----
            Tag::File,
            0_u64.to_le_bytes(),
            13_u64.to_le_bytes(),
            sha256("Hello, World!"),
            Timestamps::default(),

            // ==== Data Section ====
            13_u64.to_le_bytes(),
            "Hello, World!",
        };
        let volume_hash: [u8; 32] = sha2::Sha256::digest(&volume_header_and_data).into();
        let first_volume_section = bytes! {
            Tag::Volume,
            volume_hash,
            229_u64.to_le_bytes(),
            volume_header_and_data,
        };

        let index = Index {
            manifest: IndexEntry {
                span: Span::new(437, 42),
                checksum: Checksum::sha256(sha256(&manifest_section[41..])),
            },
            atoms: IndexEntry {
                span: Span::new(479, 122),
                checksum: Checksum::sha256(sha256(&atoms_section[41..])),
            },
            volumes: [(
                "first".to_string(),
                IndexEntry {
                    span: Span::new(601, 270),
                    checksum: Checksum::sha256(sha256(&first_volume_section[41..])),
                },
            )]
            .into_iter()
            .collect(),
            signature: Signature::none(),
        };

        let mut serialized_index = vec![];
        ciborium::into_writer(&index, &mut serialized_index).unwrap();
        let index_section = bytes! {
            Tag::Index,
            420_u64.to_le_bytes(),
            serialized_index,
            // padding bytes to compensate for an unknown index length
            // NOTE: THIS VALUE IS COMPLETELY RANDOM AND YOU SHOULD GUESS WHAT VALUE
            // WILL WORK.
            [0_u8; 75],
        };

        assert_bytes_eq!(
            &webc,
            bytes! {
                crate::MAGIC,
                Version::V3,
                index_section,
                manifest_section,
                atoms_section,
                first_volume_section,
            }
        );

        // make sure the index is accurate
        assert_bytes_eq!(&webc[index.manifest.span], manifest_section);
        assert_bytes_eq!(&webc[index.atoms.span], atoms_section);
        assert_bytes_eq!(&webc[index.volumes["first"].span], first_volume_section);

        Ok(())
    }
}
