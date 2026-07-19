#![cfg(feature = "v3")]
use std::collections::BTreeMap;

use bytes::Buf;
use webc::{
    metadata::Manifest,
    v3::{
        read::{OwnedReader, Section, StreamingReader},
        write::Writer,
        ChecksumAlgorithm, SignatureAlgorithm,
    },
};

#[test]
fn round_trip_simplest_possible_webc_file() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = Manifest::default();

    let buffer = Writer::new(ChecksumAlgorithm::None)
        .write_manifest(&manifest)?
        .write_atoms(BTreeMap::new())?
        .finish(SignatureAlgorithm::None)?;

    // First, read the WEBC file using our streaming reader
    let reader = StreamingReader::new(buffer.clone().reader())?;

    for section in reader.sections() {
        match section? {
            Section::Index(_) => {}
            Section::Manifest(m) => {
                let parsed_manifest = m.manifest()?;
                assert_eq!(parsed_manifest, manifest);
            }
            Section::Atoms(atoms) => {
                assert_eq!(atoms.iter().count(), 0);
            }
            _ => {
                unreachable!();
            }
        }
    }

    // Now, use the owned variant
    let owned = OwnedReader::parse(buffer)?;

    assert_eq!(owned.manifest(), &manifest);
    assert_eq!(owned.atom_names().count(), 0);
    assert_eq!(owned.iter_atoms().count(), 0);
    assert_eq!(owned.volume_names().count(), 0);
    assert_eq!(owned.iter_volumes().count(), 0);

    Ok(())
}
