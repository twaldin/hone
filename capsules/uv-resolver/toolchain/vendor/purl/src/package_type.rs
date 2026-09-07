//! Support for known package types.

use std::borrow::Cow;
use std::fmt;
use std::str::FromStr;

use phf::phf_map;
#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};
use unicase::UniCase;

use crate::{
    lowercase_in_place, GenericPurl, GenericPurlBuilder, ParseError, PurlField, PurlShape,
    SmallString,
};

/// A PURL that supports the known package types.
///
/// The spec lists many types, and some of the types may not be correct or fully
/// described. Rather than implementing an exhaustive list and potentially
/// claiming to support something that is incorrectly implemented, only some
/// types are supported here. (see also [package-url/purl-spec#38])
///
/// If you need additional types or different behavior, you can provide your own
/// [`PurlShape`] implementation.
///
/// [package-url/purl-spec#38]: https://github.com/package-url/purl-spec/issues/38
///
/// # Differences compared to current PURL spec
///
/// - The PURL spec says that NuGet package names are case sensitive, but this
///   implementation converts them to lowercase. This is consistent with the
///   behavior of NuGet, which requires clients to convert package names to
///   lowercase before calling the v3 package API. ([package-url/purl-spec#226])
/// - The PURL spec's implementation of Python package name normalization is
///   incomplete. In addition to converting dashes to underscores, periods are
///   also converted to underscores, and consequitive underscores are combined
///   into single underscores. This implementation matches the Python behavior.
///   ([package-url/purl-spec#165])
/// - The PURL spec says that NPM package names are case insensitive, but this
///   implementation does not convert them to lowercase. *New* NPM packages must
///   have lowercase names, but there are already NPM packages in existance with
///   uppercase names and those packages are distinct from other packages that
///   have the same name in lowercase. ([package-url/purl-spec#136])
/// - The PURL spec says that Go package namespaces and names must be lowercase,
///   but this implementation does not convert them to lowercase. Go modules can
///   have mixed case names, and mixed case names are distinct.
///   ([package-url/purl-spec#196])
/// - Some implementations treat '+' in qualifiers as '+' and some
///   implementations treat '+' as ' '. This implementation treats '+' as '+'
///   because there is nothing in the spec that says they should be ' '.
///   However, even though the spec never references x-www-form-urlencoded,
///   qualifiers look like x-www-form-urlencoded, and in x-www-form-urlencoded,
///   '+' means ' '. For compatibility with other implementations, this
///   implementation escapes '+' as %2B in qualifiers, avoiding ambiguous
///   parsing at the cost of making the PURL more difficult for humans to read.
///   Some implementations also convert '+' to ' ' in other parts of the PURL,
///   including in version numbers where they can be common, but this
///   implementation does not escape '+' there because that is an implementation
///   error, not a spec ambiguity.
///
/// [package-url/purl-spec#226]: https://github.com/package-url/purl-spec/issues/226
/// [package-url/purl-spec#165]: https://github.com/package-url/purl-spec/pull/165
/// [package-url/purl-spec#136]: https://github.com/package-url/purl-spec/issues/136
/// [package-url/purl-spec#196]: https://github.com/package-url/purl-spec/pull/196
///
/// # Extending `PackageType`
///
/// If you want to extend `PackageType` with support for another package type,
/// you can do so via delegation.
///
/// ```
/// use std::borrow::Cow;
/// use std::str::FromStr;
///
/// use purl::{
///     GenericPurl, GenericPurlBuilder, PackageError, PackageType, PurlParts, PurlShape,
///     UnsupportedPackageType,
/// };
///
/// #[derive(Clone, Copy)]
/// enum MyPackageType {
///     PackageType(PackageType),
///     Custom,
/// }
///
/// type Purl = GenericPurl<MyPackageType>;
///
/// impl FromStr for MyPackageType {
///     type Err = UnsupportedPackageType;
///
///     fn from_str(s: &str) -> Result<Self, Self::Err> {
///         // Always try your types first.
///         // Otherwise there may be unexpected behavioral changes if PackageType starts
///         // supporting your types.
///         if s.eq_ignore_ascii_case("custom") {
///             Ok(MyPackageType::Custom)
///         } else {
///             PackageType::from_str(s).map(MyPackageType::PackageType)
///         }
///     }
/// }
///
/// impl PurlShape for MyPackageType {
///     type Error = PackageError;
///
///     fn package_type(&self) -> Cow<str> {
///         match self {
///             MyPackageType::PackageType(t) => t.package_type(),
///             MyPackageType::Custom => Cow::Borrowed("custom"),
///         }
///     }
///
///     fn finish(&mut self, parts: &mut PurlParts) -> Result<(), Self::Error> {
///         match self {
///             MyPackageType::PackageType(t) => t.finish(parts),
///             MyPackageType::Custom => {
///                 // your logic here
///                 Ok(())
///             },
///         }
///     }
/// }
///
/// assert!(matches!(
///     Purl::from_str("pkg:custom/example").unwrap().package_type(),
///     MyPackageType::Custom,
/// ));
/// ```
pub type Purl = GenericPurl<PackageType>;

/// A PURL builder that supports the known package types.
pub type PurlBuilder = GenericPurlBuilder<PackageType>;

/// The known package types.
///
/// This is a subset of the types described in the PURL spec repository. See
/// [`Purl`] for details.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[non_exhaustive]
pub enum PackageType {
    Cargo,
    Gem,
    Golang,
    Maven,
    Npm,
    NuGet,
    PyPI,
}

static PACKAGE_TYPES: phf::Map<UniCase<&'static str>, PackageType> = phf_map! {
    UniCase::ascii("cargo") => PackageType::Cargo,
    UniCase::ascii("gem") => PackageType::Gem,
    UniCase::ascii("golang") => PackageType::Golang,
    UniCase::ascii("maven") => PackageType::Maven,
    UniCase::ascii("npm") => PackageType::Npm,
    UniCase::ascii("nuget") => PackageType::NuGet,
    UniCase::ascii("pypi") => PackageType::PyPI,
};

impl PackageType {
    /// Get the name of the package type as a `&'static str`.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            PackageType::Cargo => "cargo",
            PackageType::Gem => "gem",
            PackageType::Golang => "golang",
            PackageType::Maven => "maven",
            PackageType::Npm => "npm",
            PackageType::NuGet => "nuget",
            PackageType::PyPI => "pypi",
        }
    }
}

impl From<PackageType> for &'static str {
    fn from(value: PackageType) -> Self {
        value.name()
    }
}

impl AsRef<str> for PackageType {
    fn as_ref(&self) -> &str {
        self.name()
    }
}

impl fmt::Display for PackageType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// An error that is returned when an unsupported package type is used.
#[derive(Debug, thiserror::Error)]
#[error("Unsupported package type")]
pub struct UnsupportedPackageType;

impl FromStr for PackageType {
    type Err = UnsupportedPackageType;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        PACKAGE_TYPES.get(&UniCase::new(s)).copied().ok_or(UnsupportedPackageType)
    }
}

/// An error that is returned when working with [`PackageType`].
#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    /// One or more required field is missing.
    ///
    /// # Example
    ///
    /// ```
    /// use std::str::FromStr;
    ///
    /// use purl::{PackageError, Purl, PurlField};
    ///
    /// assert!(matches!(
    ///     Purl::from_str("pkg:maven/name@version"),
    ///     Err(PackageError::MissingRequiredField(PurlField::Namespace)),
    /// ));
    /// ```
    #[error("The {0} field must be present")]
    MissingRequiredField(PurlField),
    /// The PURL could not be parsed.
    #[error("{0}")]
    Parse(#[from] ParseError),
    /// The package type is unsupported.
    #[error("Unsupported package type")]
    UnsupportedType,
}

impl From<UnsupportedPackageType> for PackageError {
    fn from(_: UnsupportedPackageType) -> Self {
        PackageError::UnsupportedType
    }
}

impl PurlShape for PackageType {
    type Error = PackageError;

    fn package_type(&self) -> Cow<str> {
        self.name().into()
    }

    fn finish(&mut self, parts: &mut crate::PurlParts) -> Result<(), Self::Error> {
        match self {
            PackageType::Cargo | PackageType::Gem | PackageType::Npm | PackageType::Golang => {},
            PackageType::Maven => {
                if parts.namespace.is_empty() {
                    return Err(PackageError::MissingRequiredField(PurlField::Namespace));
                }
            },
            PackageType::NuGet => {
                lowercase_in_place(&mut parts.name);
            },
            PackageType::PyPI => {
                fix_pypi_name(&mut parts.name);
            },
        }
        Ok(())
    }
}

fn fix_pypi_name(name: &mut SmallString) {
    // https://packaging.python.org/en/latest/specifications/name-normalization/#name-normalization
    // Replace runs of consecutive ".-_" characters with a single "-".
    const DASH_CHARACTERS: &[char] = &['-', '_', '.'];
    if name.contains(DASH_CHARACTERS) {
        let mut result = SmallString::new();
        let mut in_dash = false;
        for c in name.chars() {
            if DASH_CHARACTERS.contains(&c) {
                if !in_dash {
                    result.push('-');
                    in_dash = true;
                }
            } else {
                in_dash = false;
                result.extend(c.to_lowercase());
            }
        }
        *name = result;
    } else {
        lowercase_in_place(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maven_requires_namespace() {
        // This is also covered by the test suite, but this one asserts that the correct
        // error is returned.
        let error = Purl::new(PackageType::Maven, "invalid").unwrap_err();
        assert!(
            matches!(error, PackageError::MissingRequiredField(PurlField::Namespace)),
            "Expected missing namespace error but got {error}",
        );
    }
}
