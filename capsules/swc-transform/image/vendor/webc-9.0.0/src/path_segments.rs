use std::{
    ffi::OsStr,
    fmt::Display,
    ops::Deref,
    path::{Path, PathBuf},
    rc::Rc,
    str::FromStr,
    sync::Arc,
};

/// Convert something into [`PathSegments`].
///
/// There are some assumptions about this conversion process:
///
/// - All paths are absolute
/// - Internal `.`'s and `..`'s are resolved
pub trait ToPathSegments {
    /// Convert to [`PathSegments`].
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError>;
}

impl ToPathSegments for str {
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        // FIXME: We'll need to define what a "path" is more, but for now I'm
        // just going to call it a series of strings split up by "/". We'll say
        // that backslashes and colons aren't allowed so people aren't tempted
        // to do PathBuf.display().to_string() on Windows and get weird results
        // because of drive numbers.

        if self.is_empty() {
            return Err(PathSegmentError::Empty);
        }

        let blacklisted_characters = ['\\', ':'];
        for c in blacklisted_characters {
            if self.contains(c) {
                return Err(PathSegmentError::InvalidCharacter(c));
            }
        }

        let mut segments: Vec<PathSegment> = Vec::new();

        for word in self.split('/') {
            if word.is_empty() {
                continue;
            }

            segments.push(word.parse()?);
        }

        Ok(PathSegments(segments))
    }
}

impl ToPathSegments for String {
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        self.as_str().to_path_segments()
    }
}

impl ToPathSegments for [&str] {
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        let segments = self
            .iter()
            .map(|s| s.parse())
            .collect::<Result<Vec<_>, _>>()?;
        Ok(PathSegments(segments))
    }
}

impl ToPathSegments for [PathSegment] {
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        Ok(PathSegments(self.to_vec()))
    }
}

impl ToPathSegments for Path {
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        if !self.has_root() {
            return Err(PathSegmentError::NotAbsolute);
        }

        let mut segments = Vec::new();

        for component in self.components() {
            match component {
                std::path::Component::Prefix(_) | std::path::Component::RootDir => segments.clear(),
                std::path::Component::CurDir => continue,
                std::path::Component::ParentDir => {
                    segments.pop();
                }
                std::path::Component::Normal(s) => {
                    let segment = s
                        .to_str()
                        .ok_or_else(|| {
                            PathSegmentError::IllegalPathComponent(
                                s.to_os_string().to_string_lossy().into_owned(),
                            )
                        })
                        .and_then(|s| s.parse())?;
                    segments.push(segment);
                }
            }
        }

        Ok(PathSegments(segments))
    }
}

impl ToPathSegments for PathBuf {
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        self.as_path().to_path_segments()
    }
}

impl ToPathSegments for Vec<PathSegment> {
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        self.as_slice().to_path_segments()
    }
}

impl<const N: usize> ToPathSegments for [&str; N] {
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        self.as_ref().to_path_segments()
    }
}

impl<T> ToPathSegments for &'_ T
where
    T: ToPathSegments + ?Sized,
{
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        (**self).to_path_segments()
    }
}

impl<T> ToPathSegments for Box<T>
where
    T: ToPathSegments + ?Sized,
{
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        (**self).to_path_segments()
    }
}

impl<T> ToPathSegments for Arc<T>
where
    T: ToPathSegments + ?Sized,
{
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        (**self).to_path_segments()
    }
}

impl<T> ToPathSegments for Rc<T>
where
    T: ToPathSegments + ?Sized,
{
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        (**self).to_path_segments()
    }
}

impl ToPathSegments for PathSegments {
    fn to_path_segments(&self) -> Result<PathSegments, PathSegmentError> {
        Ok(self.clone())
    }
}

/// A series of [`PathSegment`]s specifying the **absolute** path to something.
// TODO: rework this to avoid allocations as much as possible. Maybe using a
// smallvec and &str references for the segments.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PathSegments(pub(crate) Vec<PathSegment>);

impl PathSegments {
    /// The root path (i.e. `/`).
    pub const ROOT: PathSegments = PathSegments(Vec::new());

    /// Add a [`PathSegment`] to this path.
    pub fn push(&mut self, segment: PathSegment) {
        self.0.push(segment);
    }

    /// Remove the last [`PathSegment`] from this path, if one was present.
    pub fn pop(&mut self) -> Option<PathSegment> {
        self.0.pop()
    }

    /// Get a new path by appending a [`PathSegment`] to the current path.
    #[must_use]
    pub fn join(&self, segment: PathSegment) -> PathSegments {
        let mut path = self.clone();
        path.push(segment);
        path
    }

    /// Iterate over all the [`PathSegment`]s in this path.
    pub fn iter(&self) -> impl Iterator<Item = &'_ PathSegment> + '_ {
        IntoIterator::into_iter(self)
    }
}

impl Display for PathSegments {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0.is_empty() {
            return write!(f, "/");
        }

        for segment in self.iter() {
            write!(f, "/{segment}")?;
        }

        Ok(())
    }
}

impl<'a, A: AsRef<[&'a str]>> PartialEq<A> for PathSegments {
    fn eq(&self, other: &A) -> bool {
        let other = other.as_ref();
        self.0.len() == other.len() && self.0.iter().zip(other).all(|(lhs, &rhs)| lhs == rhs)
    }
}

impl FromIterator<PathSegment> for PathSegments {
    fn from_iter<T: IntoIterator<Item = PathSegment>>(iter: T) -> Self {
        PathSegments(iter.into_iter().collect())
    }
}

impl IntoIterator for PathSegments {
    type Item = PathSegment;

    type IntoIter = <Vec<PathSegment> as IntoIterator>::IntoIter;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl FromStr for PathSegments {
    type Err = PathSegmentError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.to_path_segments()
    }
}

impl<'a> IntoIterator for &'a PathSegments {
    type Item = &'a PathSegment;

    type IntoIter = std::slice::Iter<'a, PathSegment>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

/// An error that may occur while parsing a [`PathSegment`] or [`PathSegments`].
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum PathSegmentError {
    /// The segment wasn't valid UTF-8.
    #[error("Path segments must be UTF-8 strings, found \"{}\"", segment.escape_ascii())]
    InvalidUtf8 {
        /// The original segment.
        segment: Vec<u8>,
    },
    /// Found a path segment that isn't allowed.
    #[error("\"{_0:?}\" isn't a valid path segment")]
    IllegalPathComponent(String),
    /// Found a path segment containing illegal characters.
    #[error("Invalid character, \"{}\"", _0.escape_default())]
    InvalidCharacter(char),
    /// The path segment was empty.
    #[error("Path segments can't be empty")]
    Empty,
    /// The path wasn't absolute.
    #[error("The path isn't absolute")]
    NotAbsolute,
}

/// a cheaply cloneable path segment (i.e. the `path`, `to`, and `file.txt` in
/// `path/to/file.txt`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PathSegment(Arc<str>);

impl PathSegment {
    /// Parse a [`PathSegment`] from a string.
    pub fn parse(s: &str) -> Result<Self, PathSegmentError> {
        s.parse()
    }

    /// Get the [`PathSegment`]'s [`&str`] representation.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for PathSegment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        Display::fmt(self.as_str(), f)
    }
}

impl TryFrom<&str> for PathSegment {
    type Error = PathSegmentError;

    fn try_from(s: &str) -> Result<Self, Self::Error> {
        const ILLEGAL_SEGMENTS: &[&str] = &[".", ".."];

        // TODO: use proper error types and some more sophisticated
        // validation/parsing than string operations.

        // TODO: Prohibit the following characters once we've figured out
        // a naming scheme for vendored volumes and files in WEBC.
        // let blacklist = [":", "/", "\"];
        // for c in blacklist {
        //   if s.contains(c) {
        //     return Err(PathSegmentError::InvalidCharacter(c));
        //   }
        // }

        if s.is_empty() {
            Err(PathSegmentError::Empty)
        } else if ILLEGAL_SEGMENTS.contains(&s) {
            Err(PathSegmentError::IllegalPathComponent(s.into()))
        } else {
            Ok(PathSegment(s.into()))
        }
    }
}

impl TryFrom<&OsStr> for PathSegment {
    type Error = PathSegmentError;

    fn try_from(value: &OsStr) -> Result<Self, Self::Error> {
        value
            .to_str()
            .ok_or_else(|| {
                PathSegmentError::IllegalPathComponent(
                    value.to_os_string().to_string_lossy().into_owned(),
                )
            })
            .and_then(|s| s.try_into())
    }
}

impl FromStr for PathSegment {
    type Err = PathSegmentError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.try_into()
    }
}

impl Deref for PathSegment {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl AsRef<str> for PathSegment {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl PartialEq<str> for PathSegment {
    fn eq(&self, other: &str) -> bool {
        &**self == other
    }
}

impl PartialEq<&str> for PathSegment {
    fn eq(&self, other: &&str) -> bool {
        self == *other
    }
}

impl PartialEq<PathSegment> for &str {
    fn eq(&self, other: &PathSegment) -> bool {
        *other == *self
    }
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use super::*;

    #[test]
    fn invalid_path_segment() {
        let paths = ["..", "", "."];

        for path in paths {
            let _ = path.to_path_segments().unwrap_err();
        }
    }

    #[test]
    fn parse_path_segments_from_strings() {
        let inputs: &[(&str, &[&str])] = &[
            ("/", &[]),
            ("root", &["root"]),
            ("/root", &["root"]),
            ("path/to", &["path", "to"]),
            ("path/to//file.txt", &["path", "to", "file.txt"]),
        ];

        for (src, expected) in inputs {
            let path = src.to_path_segments().unwrap();
            assert_eq!(path, *expected);

            // make sure the definition matches up with our write module
            for segment in &path {
                let _: PathSegment = segment.parse().unwrap();
            }
        }
    }

    #[test]
    fn the_empty_string_isnt_allowed() {
        let error = "".to_path_segments().unwrap_err();

        assert_eq!(error, PathSegmentError::Empty);
    }

    #[test]
    fn order_lexiconographically_by_segment() {
        let inputs = [
            ("/a", "/a/", Ordering::Equal),
            ("/a", "/b", Ordering::Less),
            ("/azzzz", "/a/a", Ordering::Greater),
            ("/a/zzzz", "/a/a", Ordering::Greater),
        ];

        for (left, right, expected) in inputs {
            let left = left.to_path_segments().unwrap();
            let right = right.to_path_segments().unwrap();
            assert_eq!(left.cmp(&right), expected, "{left:?}, {right:?}");
        }
    }

    #[test]
    fn backslash_isnt_allowed() {
        let src = r"\path\to\file";

        let err = src.to_path_segments().unwrap_err();

        assert_eq!(err, PathSegmentError::InvalidCharacter('\\'));
    }

    #[test]
    fn reject_drive_numbers() {
        let src = r"C:";

        let err = src.to_path_segments().unwrap_err();

        assert_eq!(err, PathSegmentError::InvalidCharacter(':'));
    }

    #[test]
    fn convert_std_path() {
        // Note: these paths all work on both Windows and Linux
        assert_eq!(
            Path::new("/").to_path_segments().unwrap(),
            PathSegments::ROOT,
        );
        assert_eq!(
            Path::new("/path/./to/./file.txt")
                .to_path_segments()
                .unwrap(),
            ["path", "to", "file.txt"].to_path_segments().unwrap(),
        );
        assert_eq!(
            Path::new("/path/../file.txt").to_path_segments().unwrap(),
            ["file.txt"].to_path_segments().unwrap(),
        );
        assert_eq!(
            Path::new("/path/to/file.txt").to_path_segments().unwrap(),
            ["path", "to", "file.txt"].to_path_segments().unwrap(),
        );

        assert_eq!(
            Path::new(".").to_path_segments().unwrap_err(),
            PathSegmentError::NotAbsolute,
        );
        assert_eq!(
            Path::new("..").to_path_segments().unwrap_err(),
            PathSegmentError::NotAbsolute,
        );
        assert_eq!(
            Path::new("").to_path_segments().unwrap_err(),
            PathSegmentError::NotAbsolute,
        );
    }

    #[test]
    #[cfg_attr(not(windows), ignore = "Only works with Path's logic on Windows")]
    fn convert_windows_paths() {
        let inputs: Vec<(&str, &[&str])> = vec![
            (r"C:\path\to\file.txt", &["path", "to", "file.txt"]),
            (r"C:/path/to/file.txt", &["path", "to", "file.txt"]),
            (r"\\system07\C$\", &[]),
            (r"c:\temp\test-file.txt", &["temp", "test-file.txt"]),
            (
                r"\\127.0.0.1\c$\temp\test-file.txt",
                &["temp", "test-file.txt"],
            ),
            (r"\\.\c:\temp\test-file.txt", &["temp", "test-file.txt"]),
            (r"\\?\c:\temp\test-file.txt", &["temp", "test-file.txt"]),
            (
                r"\\.\Volume{b75e2c83-0000-0000-0000-602f00000000}\temp\test-file.txt",
                &["temp", "test-file.txt"],
            ),
        ];

        for (path, expected) in inputs {
            let normalized = Path::new(path).to_path_segments().unwrap();
            assert_eq!(normalized, expected.to_path_segments().unwrap(), "{path:?}");
        }
    }
}
