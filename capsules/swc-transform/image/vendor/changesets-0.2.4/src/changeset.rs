use std::{collections::HashMap, path::Path};

use crate::{
    change::{LoadingError, UniqueId},
    Change, ChangeType, PackageName,
};

/// A set of [`Change`]s that combine to form [`Release`]s of one or more packages.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeSet {
    pub releases: HashMap<PackageName, Release>,
}

impl ChangeSet {
    /// Load from a directory (usually called `.changeset`) containing markdown files.
    ///
    /// Any files that do not end with `.md` will be ignored.
    ///
    /// # Errors
    ///
    /// 1. Directory does not exist
    /// 2. There is a problem loading a file (see [`Change`] for details)
    pub fn from_directory<P: AsRef<Path>>(path: P) -> Result<Self, LoadingError> {
        path.as_ref()
            .read_dir()?
            .filter_map(|entry| {
                entry
                    .map_err(LoadingError::from)
                    .and_then(|entry| {
                        let path = entry.path();
                        if path.extension().is_some_and(|ext| ext == "md") && path.is_file() {
                            Change::from_file(path).map(Some)
                        } else {
                            Ok(None)
                        }
                    })
                    .transpose()
            })
            .collect()
    }
}

impl FromIterator<Change> for ChangeSet {
    fn from_iter<T: IntoIterator<Item = Change>>(iter: T) -> Self {
        let mut releases = HashMap::new();
        for change in iter {
            for (package_name, change_type) in change.versioning {
                let release = releases
                    .entry(package_name.clone())
                    .or_insert_with(|| Release {
                        package_name,
                        changes: Vec::new(),
                    });
                release.changes.push(PackageChange {
                    unique_id: change.unique_id.clone(),
                    change_type,
                    summary: change.summary.clone(),
                });
            }
        }
        for release in releases.values_mut() {
            release
                .changes
                .sort_by(|first, second| first.unique_id.cmp(&second.unique_id));
        }
        Self { releases }
    }
}

/// The combination of applicable [`Change`]s in a [`ChangeSet`] for a single package.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Release {
    pub package_name: PackageName,
    pub changes: Vec<PackageChange>,
}

impl Release {
    /// The overall [`ChangeType`] for the package's version based on all the [`Release::changes`].
    #[must_use]
    pub fn change_type(&self) -> Option<&ChangeType> {
        self.changes.iter().map(|change| &change.change_type).max()
    }
}

/// A [`Change`] as it applies to a single package for a [`Release`],
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageChange {
    /// The ID of the originating [`Change`].
    pub unique_id: UniqueId,
    /// The type of change, which determines how the version will be bumped (if at all).
    pub change_type: ChangeType,
    /// The details of the change, as a markdown-formatted string.
    pub summary: String,
}
