//! Strongly-typed definitions for the various free-form "annotations" fields
//! in a [`crate::metadata::Manifest`].

use std::path::PathBuf;

/// The base URI used by a [`Wasi`] runner.
pub const WASI_RUNNER_URI: &str = "https://webc.org/runner/wasi";

/// The base URI used by a [`Wcgi`] runner.
pub const WCGI_RUNNER_URI: &str = "https://webc.org/runner/wcgi";

/// The base URI used by an [`Emscripten`] runner.
pub const EMSCRIPTEN_RUNNER_URI: &str = "https://webc.org/runner/emscripten";

/// The base URI used by a [WASM4] runner.
///
/// [WASM4]: https://wasm4.org/
pub const WASM4_RUNNER_URI: &str = "https://webc.org/runner/wasm4";

/// Annotations used by WASI runners.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub struct Wasi {
    #[deprecated(since = "5.5.0", note = "Use the explicit \"atom\" annotation instead")]
    pub atom: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_atom_in_volume: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exec_name: Option<String>,
}

impl Wasi {
    /// The name commonly used when storing this in an annotations dictionary.
    pub const KEY: &'static str = "wasi";

    #[allow(deprecated)]
    pub fn new(atom: impl Into<String>) -> Self {
        Wasi {
            atom: atom.into(),
            package: None,
            env: None,
            main_args: None,
            mount_atom_in_volume: None,
            cwd: None,
            exec_name: None,
        }
    }

    pub fn with_env(&mut self, key: impl AsRef<str>, value: impl AsRef<str>) -> &mut Self {
        let key = key.as_ref();
        let value = value.as_ref();
        self.env
            .get_or_insert_with(Vec::new)
            .push(format!("{key}={value}"));
        self
    }
}

/// Annotations used by WCGI runners.
#[derive(Default, Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub struct Wcgi {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialect: Option<String>,
}

impl Wcgi {
    /// The name commonly used when storing this in an annotations dictionary.
    pub const KEY: &'static str = "wcgi";
}

/// Package-level annotations specific to the WebAssembly Package Manager.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[non_exhaustive]
#[serde(rename_all = "kebab-case")]
pub struct Wapm {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license_file: Option<VolumeSpecificPath>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme: Option<VolumeSpecificPath>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub private: bool,
}

impl Wapm {
    /// The name commonly used when storing this in an annotations dictionary.
    pub const KEY: &'static str = "wapm";

    pub fn new(name: Option<String>, version: Option<String>, description: Option<String>) -> Self {
        Wapm {
            name,
            version,
            description,
            license: None,
            license_file: None,
            readme: None,
            repository: None,
            homepage: None,
            private: false,
        }
    }
}

/// The path for an item inside a particular volume.
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Deserialize, serde::Serialize,
)]
pub struct VolumeSpecificPath {
    pub volume: String,
    pub path: String,
}

/// Annotations used by Emscripten runners.
#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Emscripten {
    #[deprecated(since = "5.5.0", note = "Use the explicit \"atom\" annotation")]
    #[serde(default)]
    pub atom: Option<String>,
    #[serde(default)]
    pub package: Option<String>,
    #[serde(default)]
    pub env: Option<Vec<String>>,
    #[serde(default)]
    pub main_args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_atom_in_volume: Option<String>,
}

impl Emscripten {
    /// The name commonly used when storing this in an annotations dictionary.
    pub const KEY: &'static str = "emscripten";
}

/// A list of entries used when constructing a filesystem based on a package and
/// its dependency tree.
///
/// Filesystem mappings work by taking a directory from a volume, where the
/// volume may come from the current package or a dependency, and making it
/// available ("mounted") in a filesystem at a particular location.
///
/// The order of [`FileSystemMapping`] entries *is* important because it will
/// inform consumers how to deal with nested mounts.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FileSystemMappings(pub Vec<FileSystemMapping>);

impl std::ops::Deref for FileSystemMappings {
    type Target = Vec<FileSystemMapping>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> PartialEq<T> for FileSystemMappings
where
    Vec<FileSystemMapping>: PartialEq<T>,
{
    fn eq(&self, other: &T) -> bool {
        self.0 == *other
    }
}

impl IntoIterator for FileSystemMappings {
    type Item = FileSystemMapping;

    type IntoIter = <Vec<FileSystemMapping> as IntoIterator>::IntoIter;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl FileSystemMappings {
    /// The name commonly used when storing this in an annotations dictionary.
    pub const KEY: &'static str = "fs";
}

/// An entry used when constructing a filesystem based on a package and its
/// dependency tree.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FileSystemMapping {
    /// The alias of the dependency this filesystem mapping should come from.
    ///
    /// If not provided, the current package is used.
    pub from: Option<String>,
    /// The name of the volume.
    pub volume_name: String,
    /// The path of the mapped item within its original volume.
    #[serde(alias = "original_path")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_path: Option<String>,
    /// Where the volume should be mounted in the resulting filesystem.
    pub mount_path: String,
}

/// A command annotation which specifies which atom implements a command.
///
/// Historically, each runner would have its own annotations for tracking the
/// atom they use (see [`Wasi::atom`] and [`Emscripten::atom`]). As part of
/// fixing [#172](https://github.com/wasmerio/pirita/issues/172), the explicit
/// annotations were merged into a common [`Atom`] annotation.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub struct Atom {
    /// The name of the atom (as passed to
    /// [`Container::get_atom()`][crate::Container::get_atom]).
    pub name: String,
    /// The name of the dependency referred to by the
    /// [`Manifest::use_map`][crate::metadata::Manifest::use_map].
    ///
    /// If this is `None`, it means the atom comes from the current package.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<String>,
}

impl Atom {
    /// The name commonly used when storing this in an annotations dictionary.
    pub const KEY: &'static str = "atom";

    pub fn new(name: impl Into<String>, dependency: impl Into<Option<String>>) -> Self {
        Atom {
            name: name.into(),
            dependency: dependency.into(),
        }
    }
}

/// Annotations specific to WebAssembly modules.
///
/// These annotations provide metadata about the WebAssembly features
/// used by an atom.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub struct Wasm {
    /// WebAssembly features used by the module.
    ///
    /// All features defined in this module must correspond to WebAssembly
    /// proposals that have reached.
    /// Phase 4 (Standardize the feature) or Phase 5 (Final) status.
    ///
    /// See the full list of proposals: https://github.com/webassembly/proposals
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub features: Vec<String>,
}

impl Wasm {
    /// The name commonly used when storing this in an annotations dictionary.
    pub const KEY: &'static str = "wasm";

    /// Feature name for SIMD support.
    pub const SIMD: &'static str = "simd";

    /// Feature name for threads support.
    pub const THREADS: &'static str = "threads";

    /// Feature name for reference types support.
    pub const REFERENCE_TYPES: &'static str = "reference-types";

    /// Feature name for multi-value support.
    pub const MULTI_VALUE: &'static str = "multi-value";

    /// Feature name for bulk memory operations support.
    pub const BULK_MEMORY: &'static str = "bulk-memory";

    /// Feature name for exception handling support.
    pub const EXCEPTIONS: &'static str = "exception-handling";

    pub fn new(features: Vec<String>) -> Self {
        Wasm { features }
    }

    /// Create a new instance with only the specified features enabled
    pub fn with_features(features: &[&str]) -> Self {
        Wasm {
            features: features.iter().map(|&s| s.to_string()).collect(),
        }
    }

    /// Check if a specific feature is enabled
    pub fn has_feature(&self, feature: &str) -> bool {
        self.features.iter().any(|f| f == feature)
    }

    /// Check if SIMD is enabled
    pub fn has_simd(&self) -> bool {
        self.has_feature(Self::SIMD)
    }

    /// Check if threads support is enabled
    pub fn has_threads(&self) -> bool {
        self.has_feature(Self::THREADS)
    }

    /// Check if reference types are enabled
    pub fn has_reference_types(&self) -> bool {
        self.has_feature(Self::REFERENCE_TYPES)
    }

    /// Check if multi-value is enabled
    pub fn has_multi_value(&self) -> bool {
        self.has_feature(Self::MULTI_VALUE)
    }

    /// Check if bulk memory operations are enabled
    pub fn has_bulk_memory(&self) -> bool {
        self.has_feature(Self::BULK_MEMORY)
    }

    /// Check if exception handling is enabled
    pub fn has_exceptions(&self) -> bool {
        self.has_feature(Self::EXCEPTIONS)
    }

    /// Add a feature to the list if it's not already present
    pub fn add_feature(&mut self, feature: &str) {
        if !self.has_feature(feature) {
            self.features.push(feature.to_string());
        }
    }

    /// Enable SIMD support
    pub fn enable_simd(&mut self) {
        self.add_feature(Self::SIMD);
    }

    /// Enable threads support
    pub fn enable_threads(&mut self) {
        self.add_feature(Self::THREADS);
    }

    /// Enable reference types support
    pub fn enable_reference_types(&mut self) {
        self.add_feature(Self::REFERENCE_TYPES);
    }

    /// Enable multi-value support
    pub fn enable_multi_value(&mut self) {
        self.add_feature(Self::MULTI_VALUE);
    }

    /// Enable bulk memory operations support
    pub fn enable_bulk_memory(&mut self) {
        self.add_feature(Self::BULK_MEMORY);
    }

    /// Enable exception handling support
    pub fn enable_exceptions(&mut self) {
        self.add_feature(Self::EXCEPTIONS);
    }
}
