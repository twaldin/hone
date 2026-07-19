use std::{
    cmp::Ordering,
    collections::HashMap,
    convert::Infallible,
    error::Error,
    fmt::{Display, Formatter},
};

/// Describes how a [`crate::Change`] affects the version of relevant packages.
///
/// This is guaranteed to never be empty, as a changeset must always apply to at least one package.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Versioning(HashMap<PackageName, ChangeType>);

impl From<(&str, ChangeType)> for Versioning {
    fn from(value: (&str, ChangeType)) -> Self {
        let value = (PackageName::from(value.0), value.1);
        Self::from(value)
    }
}

impl From<(PackageName, ChangeType)> for Versioning {
    fn from(value: (PackageName, ChangeType)) -> Self {
        let mut map = HashMap::new();
        map.insert(value.0, value.1);
        Self(map)
    }
}

impl Versioning {
    /// Creates a new [`Versioning`] from an iterator of tuples.
    ///
    /// # Errors
    ///
    /// 1. If the iterator is empty, you'll get [`BuildVersioningError::EmptyVersioningError`].
    pub fn try_from_iter<Key, Value, ParseError, Iter>(
        iter: Iter,
    ) -> Result<Self, BuildVersioningError>
    where
        Key: Into<PackageName>,
        Value: TryInto<ChangeType, Error = ParseError>,
        ParseError: Into<BuildVersioningError>,
        Iter: IntoIterator<Item = (Key, Value)>,
    {
        let map = iter
            .into_iter()
            .map(|(key, value)| {
                value
                    .try_into()
                    .map_err(Into::into)
                    .map(|value| (key.into(), value))
            })
            .collect::<Result<HashMap<PackageName, ChangeType>, BuildVersioningError>>()?;
        if map.is_empty() {
            Err(BuildVersioningError::EmptyVersioningError)
        } else {
            Ok(Self(map))
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&PackageName, &ChangeType)> {
        self.0.iter()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl IntoIterator for Versioning {
    type Item = (PackageName, ChangeType);
    type IntoIter = std::collections::hash_map::IntoIter<PackageName, ChangeType>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl FromIterator<(PackageName, ChangeType)> for Versioning {
    fn from_iter<T: IntoIterator<Item = (PackageName, ChangeType)>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}

/// The error that occurs if you try to create a [`Versioning`] out of an iterator which has no items.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BuildVersioningError {
    /// The iterator was empty.
    EmptyVersioningError,
}

impl Display for BuildVersioningError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyVersioningError => {
                f.write_str("Versioning needs to contain at least one item.")
            }
        }
    }
}

impl From<Infallible> for BuildVersioningError {
    fn from(_: Infallible) -> Self {
        unreachable!()
    }
}

impl Error for BuildVersioningError {}

/// An alias to [`String`] to encode semantic meaning in [`Change::versioning`]
pub type PackageName = String;

/// The [Semantic Versioning](https://semver.org/) component which should be incremented when a [`Change`]
/// is applied.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChangeType {
    Patch,
    Minor,
    Major,
    Custom(String),
}

impl Display for ChangeType {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            ChangeType::Custom(label) => write!(f, "{label}"),
            ChangeType::Patch => write!(f, "patch"),
            ChangeType::Minor => write!(f, "minor"),
            ChangeType::Major => write!(f, "major"),
        }
    }
}

impl From<&str> for ChangeType {
    fn from(s: &str) -> Self {
        match s {
            "patch" => ChangeType::Patch,
            "minor" => ChangeType::Minor,
            "major" => ChangeType::Major,
            other => ChangeType::Custom(other.to_string()),
        }
    }
}

impl From<String> for ChangeType {
    fn from(s: String) -> Self {
        match s.as_str() {
            "patch" => ChangeType::Patch,
            "minor" => ChangeType::Minor,
            "major" => ChangeType::Major,
            _ => ChangeType::Custom(s),
        }
    }
}

impl Ord for ChangeType {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (ChangeType::Custom(_), ChangeType::Custom(_))
            | (ChangeType::Major, ChangeType::Major)
            | (ChangeType::Patch, ChangeType::Patch)
            | (ChangeType::Minor, ChangeType::Minor) => Ordering::Equal,
            (ChangeType::Custom(_), _) => Ordering::Less,
            (_, ChangeType::Custom(_)) => Ordering::Greater,
            (ChangeType::Patch, _) => Ordering::Less,
            (_, ChangeType::Patch) => Ordering::Greater,
            (ChangeType::Minor, _) => Ordering::Less,
            (_, ChangeType::Minor) => Ordering::Greater,
        }
    }
}

impl PartialOrd for ChangeType {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
