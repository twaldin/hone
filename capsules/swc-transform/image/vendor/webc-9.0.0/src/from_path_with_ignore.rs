use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
};

use crate::PathSegment;

pub(crate) fn from_path_with_ignore<'a, TDir, TDirEntry>(
    directory: impl AsRef<Path>,
    make_dir: impl Fn(&Path) -> Result<TDir, DirectoryFromPathError>,
    make_entry_dir: impl Fn(TDir) -> TDirEntry,
    make_entry_file: impl Fn(&Path) -> Result<TDirEntry, DirectoryFromPathError>,
    get_children: impl Fn(&mut TDir) -> &mut BTreeMap<PathSegment, TDirEntry>,
    get_dir_from_entry: impl Fn(&mut TDirEntry) -> Option<&mut TDir>,
) -> Result<TDir, DirectoryFromPathError>
where
    TDir: 'a,
    TDirEntry: 'a,
{
    let mut result = make_dir(directory.as_ref())?;

    let walker = ignore::WalkBuilder::new(directory.as_ref())
        .require_git(true)
        .add_custom_ignore_filename(".wasmerignore")
        .follow_links(false)
        .build();

    for entry in walker {
        let entry = entry?;

        let is_file = !entry.path().is_dir();

        let path = entry.path().strip_prefix(directory.as_ref()).map_err(|_| {
            DirectoryFromPathError::StripPrefix {
                path: entry.path().to_owned(),
                root: directory.as_ref().to_owned(),
            }
        })?;

        let mut segments = path.iter().peekable();
        let mut cursor = &mut result;
        let mut full_path = directory.as_ref().to_owned();

        while let Some(segment_str) = segments.next() {
            let segment = segment_str
                .to_str()
                .ok_or_else(|| DirectoryFromPathError::NonUtf8Path(segment_str.to_owned()))?
                .parse::<PathSegment>()?;

            let is_last = segments.peek().is_none();

            if is_last && is_file {
                get_children(cursor).insert(segment, make_entry_file(entry.path())?);
            } else {
                full_path.push(segment_str);
                let entry = match get_children(cursor).entry(segment) {
                    std::collections::btree_map::Entry::Occupied(o) => o.into_mut(),
                    std::collections::btree_map::Entry::Vacant(v) => {
                        let dir = make_dir(&full_path)?;
                        v.insert(make_entry_dir(dir))
                    }
                };

                cursor = match get_dir_from_entry(entry) {
                    Some(d) => d,
                    None => unreachable!("Path was both a file and a directory"),
                }
            }
        }
    }

    Ok(result)
}

#[derive(thiserror::Error, Debug)]
/// Error returned from `from_path_with_ignore`.
pub enum DirectoryFromPathError {
    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Failed to strip prefix
    #[error("Failed to strip root path {root} from entry {path}")]
    StripPrefix {
        /// The full path that had prefix-stripping fail
        path: PathBuf,
        /// The root path we wanted to strip from it
        root: PathBuf,
    },

    /// Non-UTF8 path encountered
    #[error("Non-UTF8 path {0:?}")]
    NonUtf8Path(OsString),

    /// Path segment parsing error
    #[error("Path segment error: {0}")]
    PathSegment(#[from] crate::PathSegmentError),

    /// Error from ignore, such as failure to parse a .gitignore file
    #[error("Ignore error: {0}")]
    Ignore(ignore::Error),
}

impl From<ignore::Error> for DirectoryFromPathError {
    fn from(e: ignore::Error) -> Self {
        match e {
            ignore::Error::Io(io) => Self::Io(io),
            _ => DirectoryFromPathError::Ignore(e),
        }
    }
}
