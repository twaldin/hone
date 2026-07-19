#![cfg(feature = "v1")]

#[macro_use]
extern crate pretty_assertions;

use std::collections::BTreeMap;

use indexmap::IndexMap;
use webc::{
    metadata::Manifest,
    v1::{Checksum, DirOrFile, GenerateChecksum, ParseOptions, Signature, Volume, WebC},
};

macro_rules! volume {
    ($( $name:expr => $value:expr ),* $(,)?) => {{
        let mut map: BTreeMap<DirOrFile, Vec<u8>> = BTreeMap::new();

        $(
            let path = if $name.ends_with('/') {
                DirOrFile::Dir($name.into())
            } else {
                DirOrFile::File($name.into())
            };
            map.insert(path, $value.to_vec());
        )*

        map
    }};
}

#[test]
fn round_trip_a_known_webc_file() {
    let manifest = Manifest {
        origin: None,
        use_map: IndexMap::new(),
        package: IndexMap::new(),
        atoms: IndexMap::new(),
        commands: IndexMap::new(),
        bindings: Vec::new(),
        entrypoint: Some("a".to_string()),
    };
    let atoms: BTreeMap<DirOrFile, Vec<u8>> = volume! {
        "/a" => b"atom-a",
        "nested/b" => b"atom-b",
    };
    let atoms = Volume::serialize_atoms(atoms);
    let first_volume = volume! { "path/to/README.md" => b"# My Project" };
    let second_volume = volume! {
        "/root" => b"asdf",
        "path/" => b"",
        "path/index.html" => b"<html></html>",
        "path/to/" => b"",
        "path/to/README.md" => b"# My Project",
    };
    let volumes: [(&str, BTreeMap<DirOrFile, Vec<u8>>); 2] =
        [("first", first_volume), ("second", second_volume)];
    let volumes: Vec<_> = volumes
        .into_iter()
        .map(|(k, v)| (k, Volume::serialize_files(v)))
        .collect();

    let webc = WebC {
        version: 1,
        checksum: None,
        signature: None,
        manifest: manifest.clone(),
        atoms: Volume::parse(&atoms).unwrap(),
        volumes: volumes
            .iter()
            .map(|(k, v)| (k.to_string(), Volume::parse(v).unwrap()))
            .collect(),
    };

    let bytes = webc.into_bytes(GenerateChecksum::Sha256).unwrap();

    let options = ParseOptions::default();
    let webc = WebC::parse(&bytes, &options).unwrap();

    assert_eq!(
        webc.checksum,
        Some(Checksum {
            valid_until: 32,
            chk_type: "sha256----------".to_string(),
            data: [
                [
                    115, 180, 146, 117, 220, 106, 252, 8, 114, 31, 66, 54, 146, 102, 168, 25, 201,
                    178, 64, 7, 206, 8, 195, 249, 114, 147, 66, 6, 216, 228, 217, 95,
                ]
                .as_slice(),
                [0; 256 - 32].as_slice(),
            ]
            .concat(),
            valid: true,
        })
    );
    assert_eq!(
        webc.signature,
        Some(Signature {
            valid_until: 1024,
            data: vec![],
            valid: false,
        })
    );
    assert_eq!(webc.manifest, manifest);

    let atoms = webc.get_all_atoms();
    let expected: IndexMap<String, &[u8]> = [
        ("a".to_string(), b"atom-a".as_slice()),
        ("b".to_string(), b"atom-b"),
    ]
    .into_iter()
    .collect();
    assert_eq!(atoms, expected);

    let package_name = webc.get_package_name();
    let volume_names = webc.get_volumes_for_package(&package_name);
    assert_eq!(volume_names, vec!["first", "second"]);

    let files_in_first: Vec<_> = webc
        .get_volume(&package_name, "first")
        .unwrap()
        .get_all_file_and_dir_entries()
        .unwrap()
        .into_keys()
        .collect();
    assert_eq!(
        files_in_first,
        vec![
            DirOrFile::Dir("path".into()),
            DirOrFile::Dir("path/to".into()),
            DirOrFile::File("path/to/README.md".into()),
        ]
    );

    let second = webc.get_volume(&package_name, "second").unwrap();
    let files_in_second: Vec<_> = second
        .get_all_file_and_dir_entries()
        .unwrap()
        .into_keys()
        .collect();
    assert_eq!(
        files_in_second,
        vec![
            DirOrFile::Dir("path".into()),
            DirOrFile::Dir("path/to".into()),
            DirOrFile::File("path/index.html".into()),
            DirOrFile::File("path/to/README.md".into()),
            DirOrFile::File("root".into()),
        ]
    );
    assert_eq!(
        second.get_file("path/to/README.md").unwrap(),
        b"# My Project"
    );
    assert_eq!(
        second.get_file("path/index.html").unwrap(),
        b"<html></html>"
    );
    assert_eq!(second.get_file("root").unwrap(), b"asdf");
}
