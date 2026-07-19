//! Regression tests to make sure `wapm-targz-to-pirita` conversion will produce
//! the same results as it has in the past.

#![cfg(feature = "v2")]

#[macro_use]
extern crate pretty_assertions;

use std::{collections::BTreeMap, panic::Location, path::Path};

use bytes::Bytes;
use indexmap::IndexMap;
use webc::{
    compat::{Metadata, Volume},
    metadata::{
        annotations::{Atom, Emscripten, Wasi},
        Manifest, UrlOrManifest,
    },
    Container, PathSegments, Version,
};

const WEBC_V1: &[u8] = include_bytes!("./fixtures/bindings-package-test-3.webc");
const WEBC_V2: &[u8] = include_bytes!("./cowsay.webc");

#[test]
#[cfg_attr(not(feature = "v1"), ignore)]
fn read_webc_v1() {
    assert_eq!(webc::detect(WEBC_V1).unwrap(), Version::V1);

    let webc = Container::from_bytes_and_version(Bytes::from(WEBC_V1), Version::V1).unwrap();

    // ciborium and serde_json have different orderings so we serialize-deserialize again
    // using serde_json to match the expected ordering of fields.
    let webc_manifest = webc.manifest();
    let webc_manifest: Manifest =
        serde_json::from_value(serde_json::to_value(webc_manifest).unwrap()).unwrap();

    // Make sure we get the following manifest
    let expected_manifest: Manifest = serde_json::from_value(serde_json::json! {
        {
            "atoms": {
              "entry": {
                "kind": "https://webc.org/kind/wasm",
                "signature": "sha256:l6BDeuPzv/vsgXIMfGs+mg3k6raif/fJUen0XVzIjTA="
              }
            },
            "bindings": [
              {
                "annotations": {
                  "wit": {
                    "exports": "metadata://./bindings.wit",
                    "module": "atoms://entry"
                  }
                },
                "kind": "wit@0.1.0",
                "name": "library-bindings"
              }
            ],
            "package": {
              "wapm": {
                "description": "Package description for bindings-package-test-3",
                "license": "ISC",
                "name": "bindings-package-test-3",
                "version": "1.0.0"
              }
            }
          }
    })
    .unwrap();
    assert_eq!(&webc_manifest, &expected_manifest);

    let atoms = webc.atoms();
    let atom_names: Vec<_> = atoms.keys().map(|s| s.as_str()).collect();
    assert_eq!(atom_names, ["entry"]);

    let volumes = webc.volumes();
    let volume_names: Vec<_> = volumes.keys().map(|s| s.as_str()).collect();
    assert_eq!(volume_names, ["atom", "metadata"]);

    let atom_volume = &volumes["atom"];
    assert_eq!(atom_volume.read_dir("/").unwrap().len(), 2);
    assert_eq!(atom_volume.read_file("bindings.wit").unwrap().0.len(), 36);
    assert_eq!(atom_volume.read_file("entry.wat").unwrap().0.len(), 110);

    record_snapshots(&webc);
}

#[test]
#[cfg_attr(not(feature = "v2"), ignore)]
fn read_webc_v2() {
    assert_eq!(webc::detect(WEBC_V2).unwrap(), Version::V2);

    let webc = Container::from_bytes_and_version(Bytes::from(WEBC_V2), Version::V2).unwrap();

    // ciborium and serde_json have different orderings so we serialize-deserialize again
    // using serde_json to match the expected ordering of fields.
    let webc_manifest = webc.manifest();
    let webc_manifest: Manifest =
        serde_json::from_value(serde_json::to_value(webc_manifest).unwrap()).unwrap();

    let expected_manifest: Manifest = serde_json::from_value(serde_json::json!(
      {
        "package": {
          "wapm": {
            "name": "wiqar/cowsay",
            "readme": {
              "path": "README.md",
              "volume": "metadata"
            },
            "version": "0.3.0",
            "repository": "https://github.com/wapm-packages/cowsay",
            "description": "cowsay is a program that generates ASCII pictures of a cow with a message"
          }
        },
        "atoms": {
          "cowsay": {
            "kind": "https://webc.org/kind/wasm",
            "signature": "sha256:DPmhiSNXCg5261eTUi3BIvAc/aJttGj+nD+bGhQkVQo="
          }
        },
        "commands": {
          "cowsay": {
            "runner": "https://webc.org/runner/wasi",
            "annotations": {
              "wasi": {
                "atom": "cowsay",
                "package": null,
                "main_args": null
              }
            }
          },
          "cowthink": {
            "runner": "https://webc.org/runner/wasi",
            "annotations": {
              "wasi": {
                "atom": "cowsay",
                "package": null,
                "main_args": null
              }
            }
          }
        }
      }
    )).unwrap();
    assert_eq!(&webc_manifest, &expected_manifest);

    let atoms = webc.atoms();
    let atom_names = atoms.keys().collect::<Vec<_>>();
    assert_eq!(atom_names, ["cowsay"]);
    assert!(webc.get_atom("cowsay").unwrap().starts_with(b"\0asm"));

    let volumes = webc.volumes();
    let volume_names = volumes.keys().collect::<Vec<_>>();
    assert_eq!(volume_names, ["atom", "metadata"]);

    let atom_volume = webc.get_volume("atom").unwrap();
    assert_eq!(atom_volume.read_dir("/").unwrap().len(), 0);

    let metadata_volume = webc.get_volume("metadata").unwrap();
    assert_eq!(
        metadata_volume.read_file("/README.md").unwrap().0.len(),
        2542
    );
    assert_eq!(metadata_volume.read_file("/LICENSE").unwrap().0.len(), 1070);

    record_snapshots(&webc);
}

#[test]
fn container_unpack() {
    let dir = tempfile::tempdir().unwrap();
    let webc = Container::from_bytes_and_version(Bytes::from(WEBC_V2), Version::V2).unwrap();
    webc.unpack(dir.path(), false).unwrap();

    assert_eq!(
        dir.path()
            .join("metadata/README.md")
            .metadata()
            .unwrap()
            .len(),
        2542
    );

    let manifest_path = dir.path().join("manifest.json");
    let manifest_data = std::fs::read_to_string(manifest_path).unwrap();
    let manifest = serde_json::from_str::<Manifest>(&manifest_data).unwrap();
    assert_eq!(&manifest, webc.manifest(),);
}

#[test]
fn container_unpack_overwrite() {
    let dir = tempfile::tempdir().unwrap();

    std::fs::write(dir.path().join("hello"), "123").unwrap();

    let webc = Container::from_bytes_and_version(Bytes::from(WEBC_V2), Version::V2).unwrap();
    let res = webc.unpack(dir.path(), false);
    assert!(res.is_err(), "should not unpack into non-empty directory");

    // Should ignore the existing file with overwrite=true.
    webc.unpack(dir.path(), true).unwrap();
    assert_eq!(
        dir.path()
            .join("metadata/README.md")
            .metadata()
            .unwrap()
            .len(),
        2542
    );
}

// Right now backend is using webc v2 so the latest version of webc (ie. v3)
// is incompatible with what backend returns. Once backend transitions to v3,
// this should be re-enabled and pass.
#[ignore = "we have a breaking change in FileSystemMap"]
#[test]
fn website_with_static_web_server_dependency() {
    let (_tarball, mut manifest) = fixtures::load("wasmer", "docs", "0.15.1");
    patch_up_dependencies(&mut manifest);

    // let pkg = Package::from_tarball_file(tarball).unwrap();

    // assert_eq!(pkg.manifest(), &manifest);
    // insta::assert_yaml_snapshot!(pkg.manifest());
}

/// When wasmer-toml went to 0.7.0, it switched from using a bare `String` to
/// a `semver::VersionReq` for dependency versions. This function will patch
/// up old manifests so you get the `^` in
/// `coreutils: sharrattj/coreutils@^1.0.16`.
///
/// When we merged pirita#178, we changed things so `"wasmer/python" = "1.2.3"`
/// would be translated to `"wasmer/python": "wasmer/python@1.2.3"` instead of
/// `"python": "wasmer/python@1.2.3"` (i.e. the full package name is used as the
/// dependency alias, rather than just the name section).
fn patch_up_dependencies(manifest: &mut Manifest) {
    for (_, dep) in &mut manifest.use_map {
        if let UrlOrManifest::RegistryDependentUrl(url) = dep {
            let (name, version) = url.split_once('@').unwrap();
            if !version.starts_with('^') {
                *url = format!("{name}@^{version}");
            }
        }
    }

    let aliases_to_rename: Vec<_> = manifest
        .use_map
        .iter()
        .filter_map(|(alias, dep)| match dep {
            UrlOrManifest::RegistryDependentUrl(url) => {
                let (name, _) = url.split_once('@').unwrap();

                if name != alias {
                    Some((alias.clone(), name.to_string()))
                } else {
                    None
                }
            }
            _ => None,
        })
        .collect();
    for (old_alias, new_alias) in aliases_to_rename {
        let value = manifest.use_map.swap_remove(&old_alias).unwrap();
        manifest.use_map.insert(new_alias, value);
    }
}

// Right now backend is using webc v2 so the latest version of webc (ie. v3)
// is incompatible with what backend returns. Once backend transitions to v3,
// this should be re-enabled and pass.
#[ignore = "we have a breaking change in FileSystemMap"]
#[test]
fn static_web_server() {
    let (_tarball, mut manifest) = fixtures::load("sharrattj", "static-web-server", "1.0.96");
    patch_up_commands(&mut manifest.commands);
    patch_up_wapm_metadata(manifest.package.get_mut("wapm").unwrap());

    // let pkg = Package::from_tarball_file(tarball).unwrap();

    // assert_eq!(pkg.manifest(), &manifest);
    // insta::assert_yaml_snapshot!(pkg.manifest());
}

/// Patch up `"wapm"` annotations so that they use absolute paths when referring
/// to a volume-specific item.
fn patch_up_wapm_metadata(wapm: &mut ciborium::Value) {
    let map = match wapm {
        ciborium::Value::Map(map) => map,
        _ => return,
    };

    let keys = ["license-file", "readme"];

    for key in keys {
        let key = ciborium::Value::Text(key.to_string());
        let path = ciborium::Value::Text("path".to_string());

        let mut value = match map.iter_mut().find(|e| e.0 == key).map(|e| e.1.clone()) {
            Some(ciborium::Value::Map(v)) => v,
            _ => continue,
        };
        match value.iter_mut().find(|e| e.0 == path).map(|e| e.1.clone()) {
            Some(ciborium::Value::Text(mut s)) if !s.starts_with('/') => {
                s.insert(0, '/');
            }
            _ => continue,
        }
    }
}

/// Patch up minor differences between current and previous versions of
/// `wapm-targz-to-pirita`.
#[allow(deprecated)]
fn patch_up_commands(commands: &mut IndexMap<String, webc::metadata::Command>) {
    for (name, cmd) in commands {
        // We've used several URIs for the WASI runner in the past
        let wasi_command_names = ["https://webc.org/runner/wasi@unstable_"];
        if wasi_command_names.contains(&cmd.runner.as_str()) {
            cmd.runner = webc::metadata::annotations::WASI_RUNNER_URI.to_string();
        }

        if cmd.runner.as_str() == webc::metadata::annotations::WASI_RUNNER_URI
            && !cmd.annotations.contains_key(Wasi::KEY)
        {
            // We now always set "wasi.atom", even if the command has the
            // same name as the module it uses.
            cmd.annotations.insert(
                Wasi::KEY.to_string(),
                ciborium::Value::serialized(&Wasi::new(name)).unwrap(),
            );
        }

        if let Some(Wasi { atom, .. }) = cmd.annotation(Wasi::KEY).unwrap() {
            cmd.annotations.insert(
                Atom::KEY.to_string(),
                ciborium::Value::serialized(&Atom::new(atom, None)).unwrap(),
            );
        }

        if let Some(Emscripten {
            atom: Some(atom), ..
        }) = cmd.annotation(Emscripten::KEY).unwrap()
        {
            cmd.annotations.insert(
                Atom::KEY.to_string(),
                ciborium::Value::serialized(&Atom::new(atom, None)).unwrap(),
            );
        }
    }
}

/// Record a snapshot of the [`Container`]'s contents.
#[track_caller]
fn record_snapshots(container: &Container) {
    let mut settings = insta::Settings::clone_current();
    let location = Location::caller();
    let caller = calling_function(location);

    settings.set_snapshot_suffix(format!("{caller}.manifest"));
    settings.bind(|| insta::assert_yaml_snapshot!(container.manifest()));

    let atoms: BTreeMap<String, usize> = container
        .atoms()
        .into_iter()
        .map(|(k, v)| (k, v.len()))
        .collect();
    settings.set_snapshot_suffix(format!("{caller}.atoms"));
    settings.bind(|| insta::assert_yaml_snapshot!(atoms));

    let volumes: BTreeMap<String, BTreeMap<String, Metadata>> = container
        .volumes()
        .into_iter()
        .map(|(k, volume)| (k, volume_metadata(&volume)))
        .collect();
    settings.set_snapshot_suffix(format!("{caller}.volumes"));
    settings.bind(|| insta::assert_yaml_snapshot!(volumes));
}

/// Determine the name of the calling function based on a [`Location`].
fn calling_function(location: &Location) -> String {
    let filename = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .find_map(|base_dir| {
            let path = base_dir.join(location.file());
            path.exists().then_some(path)
        })
        .unwrap();
    let src = std::fs::read_to_string(filename).unwrap();

    let lines: Vec<_> = src.lines().take(location.line() as usize).collect();
    let function_line = lines.iter().rfind(|line| line.contains("fn ")).unwrap();
    let line_starting_with_ident = function_line.trim().trim_start_matches("fn ");
    let opening_paren = line_starting_with_ident.find('(').unwrap();

    line_starting_with_ident[..opening_paren].to_string()
}

fn volume_metadata(volume: &Volume) -> BTreeMap<String, Metadata> {
    fn all_files(
        volume: &Volume,
        path: &mut PathSegments,
        metadata: &mut BTreeMap<String, Metadata>,
    ) {
        for (segment, _hash, mut meta) in volume.read_dir(&*path).unwrap() {
            // do not include timestamps in snapshot testing since it will change every time
            // we run the test.

            // Clear timestamps for snapshot testing
            if let Some(timestamps) = meta.timestamps_mut() {
                *timestamps = Default::default();
            }

            path.push(segment);

            if meta.is_dir() {
                all_files(volume, path, metadata);
            }

            metadata.insert(path.to_string(), meta);
            path.pop();
        }
    }

    let mut path = PathSegments::ROOT;
    let mut metadata = BTreeMap::new();

    all_files(volume, &mut path, &mut metadata);

    metadata
}

mod fixtures {
    use std::path::{Path, PathBuf};

    use tempfile::NamedTempFile;

    const GRAPHQL_ENDPOINT: &str = "https://registry.wasmer.io/graphql";
    const QUERY: &str = r#"
{
    getPackageVersion(name: "$NAMESPACE/$PACKAGE", version: "=$VERSION") {
        piritaManifest
        distribution { downloadUrl }
    }
}"#;

    pub fn load(
        namespace: &str,
        package: &str,
        version: &str,
    ) -> (PathBuf, webc::metadata::Manifest) {
        let cache_dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(env!("CARGO_PKG_NAME"))
            .join(namespace)
            .join(format!("{package}-{version}"));
        let tarball = cache_dir.join(format!("{package}-{version}.tar.gz"));
        let manifest = cache_dir.join("manifest.json");

        if !tarball.exists() {
            #[derive(serde::Serialize)]
            struct Body {
                query: String,
            }

            let body = serde_json::to_string(&Body {
                query: QUERY
                    .replace("$NAMESPACE", namespace)
                    .replace("$PACKAGE", package)
                    .replace("$VERSION", version),
            })
            .unwrap();

            let response = ureq::post(GRAPHQL_ENDPOINT)
                .set("Content-Type", "application/json")
                .send_string(&body)
                .unwrap();
            let status = response.status();
            let body = response.into_string().unwrap();
            assert_eq!(status, 200, "{body}");
            let Response { data, errors } = serde_json::from_str(&body).unwrap();
            if let Some(errors) = errors {
                panic!("One or more errors occurred: {errors}");
            }
            std::fs::create_dir_all(&cache_dir).unwrap();
            let mut temp = NamedTempFile::new_in(&cache_dir).unwrap();
            let response = ureq::get(&data.get_package_version.distribution.download_url)
                .call()
                .unwrap();
            assert_eq!(response.status(), 200);
            std::io::copy(&mut response.into_reader(), &mut temp).unwrap();

            temp.persist(&tarball).unwrap();
            std::fs::write(&manifest, &data.get_package_version.pirita_manifest).unwrap();
        }

        let manifest = std::fs::read_to_string(&manifest).unwrap();
        let manifest = serde_json::from_str(&manifest).unwrap();

        (tarball, manifest)
    }

    #[derive(Debug, serde::Deserialize)]
    struct Response {
        data: Data,
        #[serde(default)]
        errors: Option<serde_json::Value>,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Data {
        get_package_version: PackageVersion,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PackageVersion {
        pirita_manifest: String,
        distribution: Distribution,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Distribution {
        download_url: String,
    }
}
