//! Support for parsing PURLs.

use std::borrow::Cow;
use std::convert::Infallible;
use std::fmt::{self, Write};
use std::str::FromStr;

use percent_encoding::percent_decode_str;

use crate::qualifiers::Entry;
use crate::{
    is_valid_package_type, GenericPurl, GenericPurlBuilder, PurlParts, PurlShape, SmallString,
};

/// An error returned when trying to parse an invalid PURL.
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    /// The URL scheme is not pkg.
    ///
    /// # Example
    ///
    /// ```
    /// use std::str::FromStr;
    ///
    /// use purl::{GenericPurl, ParseError};
    ///
    /// assert!(matches!(
    ///     GenericPurl::<String>::from_str("http://example.com"),
    ///     Err(ParseError::UnsupportedUrlScheme),
    /// ));
    /// ```
    #[error("URL scheme must be pkg")]
    UnsupportedUrlScheme,
    /// The PURL is incomplete.
    ///
    /// # Example
    ///
    /// ```
    /// use std::str::FromStr;
    ///
    /// use purl::{GenericPurl, ParseError, PurlField};
    ///
    /// assert!(matches!(
    ///     GenericPurl::<String>::from_str("pkg:npm"),
    ///     Err(ParseError::MissingRequiredField(PurlField::Name)),
    /// ));
    /// ```
    #[error("Missing required field {0}")]
    MissingRequiredField(PurlField),
    /// The package type contains invalid characters.
    ///
    /// # Example
    ///
    /// ```
    /// use std::str::FromStr;
    ///
    /// use purl::{GenericPurl, ParseError};
    ///
    /// assert!(matches!(
    ///     // Because the package type was omitted,
    ///     // the namespace is seen to be the package type.
    ///     GenericPurl::<String>::from_str("pkg:@acme/example"),
    ///     Err(ParseError::InvalidPackageType),
    /// ));
    /// ```
    #[error("Invalid package type")]
    InvalidPackageType,
    /// The PURL contains invalid qualifiers.
    ///
    /// # Example
    ///
    /// ```
    /// use std::str::FromStr;
    ///
    /// use purl::{GenericPurl, ParseError};
    ///
    /// assert!(matches!(
    ///     GenericPurl::<String>::from_str("pkg:npm/example?="),
    ///     Err(ParseError::InvalidQualifier),
    /// ));
    /// ```
    #[error("Invalid qualifier")]
    InvalidQualifier,
    /// The PURL contains illegal escaped characters.
    ///
    /// # Example
    ///
    /// ```
    /// use std::str::FromStr;
    ///
    /// use purl::{GenericPurl, ParseError};
    ///
    /// assert!(matches!(
    ///     GenericPurl::<String>::from_str("pkg:npm/%80"),
    ///     Err(ParseError::InvalidEscape),
    /// ));
    /// ```
    #[error("An escape sequence contains invalid characters")]
    InvalidEscape,
}

// This is a workaround for a typing issue. `<String as FromStr>::Err =
// Infalible`, which the compiler considers to be a normal error type.
impl From<Infallible> for ParseError {
    fn from(_: Infallible) -> Self {
        unreachable!()
    }
}

/// A specific, fixed field of a PURL.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum PurlField {
    /// The type, also known as the protocol.
    ///
    /// For example, "npm" in `pkg:npm/my-package`.
    PackageType,
    /// The namespace.
    ///
    /// For example, "my.company" in `pkg:maven/my.company/my-package`.
    Namespace,
    /// The name.
    ///
    /// For example, "my-package" in `pkg:npm/my-package`.
    Name,
    /// The version.
    ///
    /// For example, "1.0" in `pkg:npm/my-package@1.0`.
    Version,
    /// The subpath.
    ///
    /// For example, "lib" in `pkg:golang/github.com/my-company/my-package#lib`.
    Subpath,
}

impl PurlField {
    /// Get a `&'static str` representing the `PurlField`.
    pub const fn name(&self) -> &'static str {
        match self {
            PurlField::PackageType => "package type",
            PurlField::Namespace => "namespace",
            PurlField::Name => "name",
            PurlField::Version => "version",
            PurlField::Subpath => "subpath",
        }
    }
}

impl From<PurlField> for &'static str {
    fn from(value: PurlField) -> Self {
        value.name()
    }
}

impl fmt::Display for PurlField {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.name())
    }
}

impl<T> FromStr for GenericPurl<T>
where
    T: FromStr + PurlShape,
    <T as PurlShape>::Error: From<<T as FromStr>::Err>,
{
    type Err = T::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        // This mostly follows the procedure documented in the PURL spec.
        // https://github.com/package-url/purl-spec/blob/master/PURL-SPECIFICATION.rst#how-to-parse-a-purl-string-in-its-components

        // Check for `pkg:` first to quickly reject non-PURLs.
        let s = s.strip_prefix("pkg:").ok_or(ParseError::UnsupportedUrlScheme)?;

        // PURLs are not supposed to have any leading slashes, but the spec says that
        // parsers must ignore them.
        let s = s.trim_start_matches('/');

        let mut parts = PurlParts::default();

        // Remove subpath and qualifiers from the end now because they have higher
        // precedence than the path separater.
        let s = match s.rsplit_once('#') {
            Some((s, subpath)) => {
                parts.subpath = decode_subpath(subpath)?;
                s
            },
            None => s,
        };

        let s = match s.rsplit_once('?') {
            Some((s, qualifiers)) => {
                decode_qualifiers(qualifiers, &mut parts)?;
                s
            },
            None => s,
        };

        if s.is_empty() {
            return Err(ParseError::MissingRequiredField(PurlField::PackageType).into());
        }

        let (package_type, s) =
            s.split_once('/').ok_or(ParseError::MissingRequiredField(PurlField::Name))?;

        if !is_valid_package_type(package_type) {
            return Err(ParseError::InvalidPackageType.into());
        }

        let package_type = T::from_str(package_type)?;

        let s = match s.rsplit_once('@') {
            Some((s, version)) => {
                parts.version = decode(version)?.into();
                s
            },
            None => s,
        };

        // The namespace is optional so we may not have any more slashes.
        let name = match s.rsplit_once('/') {
            Some((namespace, s)) => {
                parts.namespace = decode_namespace(namespace)?;
                s
            },
            None => s,
        };

        parts.name = decode(name)?.into();

        GenericPurlBuilder { package_type, parts }.build()
    }
}

fn decode_subpath(subpath: &str) -> Result<SmallString, ParseError> {
    let subpath = subpath.trim_matches('/');

    let mut rebuilt = SmallString::new();
    for segment in subpath.split('/') {
        if segment.is_empty() {
            continue;
        }
        let decoded = decode(segment)?;
        if decoded.contains('/') {
            return Err(ParseError::InvalidEscape);
        }
        if decoded.len() < 3 && decoded.chars().all(|c| c == '.') {
            continue;
        }
        if !rebuilt.is_empty() {
            rebuilt.push('/');
        }
        write!(rebuilt, "{}", decoded).unwrap();
    }

    Ok(rebuilt)
}

fn decode_qualifiers(s: &str, parts: &mut PurlParts) -> Result<(), ParseError> {
    for qualifier in s.split('&') {
        if let Some((k, v)) = qualifier.split_once('=') {
            let Entry::Vacant(entry) = parts.qualifiers.entry(k)? else {
                return Err(ParseError::InvalidQualifier);
            };

            let v = decode(v)?;
            if v.is_empty() {
                continue;
            }

            entry.insert(v);
        } else {
            return Err(ParseError::InvalidQualifier);
        }
    }

    Ok(())
}

fn decode_namespace(namespace: &str) -> Result<SmallString, ParseError> {
    let namespace = namespace.trim_matches('/');

    let mut rebuilt = SmallString::new();
    for segment in namespace.split('/') {
        if segment.is_empty() {
            continue;
        }
        let decoded = decode(segment)?;
        if decoded.contains('/') {
            return Err(ParseError::InvalidEscape);
        }
        if !rebuilt.is_empty() {
            rebuilt.push('/');
        }
        write!(rebuilt, "{}", decoded).unwrap();
    }

    Ok(rebuilt)
}

fn decode(input: &str) -> Result<Cow<str>, ParseError> {
    percent_decode_str(input).decode_utf8().map_err(|_| ParseError::InvalidEscape)
}

#[cfg(feature = "serde")]
mod de {
    use std::marker::PhantomData;

    use serde::de::{Error, Visitor};
    use serde::Deserialize;

    use super::*;

    impl<'de, T> Deserialize<'de> for GenericPurl<T>
    where
        T: FromStr + PurlShape,
        <T as PurlShape>::Error: fmt::Display + From<<T as FromStr>::Err>,
    {
        fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
        where
            D: ::serde::Deserializer<'de>,
        {
            deserializer.deserialize_str(PurlVisitor(PhantomData))
        }
    }

    struct PurlVisitor<T>(PhantomData<T>);

    impl<T> Visitor<'_> for PurlVisitor<T>
    where
        T: FromStr + PurlShape,
        <T as PurlShape>::Error: fmt::Display + From<<T as FromStr>::Err>,
    {
        type Value = GenericPurl<T>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("A PURL string")
        }

        fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
        where
            E: Error,
        {
            GenericPurl::<T>::from_str(v).map_err(Error::custom)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    #[test]
    fn parse_when_empty_returns_error() {
        let error = GenericPurl::<String>::from_str("").unwrap_err();
        assert!(matches!(error, ParseError::UnsupportedUrlScheme));
    }

    #[test]
    fn parse_without_type_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:").unwrap_err();
        assert!(matches!(error, ParseError::MissingRequiredField(PurlField::PackageType)));
    }

    #[test]
    fn parse_without_name_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:type").unwrap_err();
        assert!(matches!(error, ParseError::MissingRequiredField(PurlField::Name)));
    }

    #[test]
    fn parse_when_type_invalid_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:@invalid/name").unwrap_err();
        assert!(matches!(error, ParseError::InvalidPackageType));
    }

    #[test]
    fn parse_when_qualifier_invalid_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:type/name?!").unwrap_err();
        assert!(matches!(error, ParseError::InvalidQualifier));
    }

    #[test]
    fn parse_when_escape_contains_illegal_chars_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:type/%80").unwrap_err();
        assert!(matches!(error, ParseError::InvalidEscape));
    }

    #[test]
    fn parse_when_escaped_namespace_component_contains_path_separator_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:type/a%2fb/name").unwrap_err();
        assert!(matches!(error, ParseError::InvalidEscape));
    }

    #[test]
    fn parse_when_namespace_contains_weird_components_preserves_them() {
        let parsed = GenericPurl::<String>::from_str("pkg:type/a//b/./c/../d/name").unwrap();
        assert_eq!("pkg:type/a/b/./c/../d/name", &parsed.to_string());
    }

    #[test]
    fn parse_when_subpath_contains_weird_components_preserves_them() {
        let parsed = GenericPurl::<String>::from_str("pkg:type/name#a/.../b/").unwrap();
        assert_eq!("pkg:type/name#a/.../b", &parsed.to_string());
    }

    #[test]
    fn parse_when_subpath_contains_invalid_components_skips_them() {
        let parsed =
            GenericPurl::<String>::from_str("pkg:type/name#/a//b/./c/../%2E%2E/d/").unwrap();
        assert_eq!("pkg:type/name#a/b/c/d", &parsed.to_string());
    }

    #[test]
    fn parse_when_escaped_subpath_component_contains_path_separator_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:type/name#a%2fb").unwrap_err();
        assert!(matches!(error, ParseError::InvalidEscape));
    }

    #[test]
    fn parse_when_qualifiers_are_duplicated_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:type/name?a=a&a=b").unwrap_err();
        assert!(matches!(error, ParseError::InvalidQualifier));
    }

    #[test]
    fn parse_when_qualifier_has_no_value_skips_it() {
        let parsed = GenericPurl::<String>::from_str("pkg:type/name?a=").unwrap();
        assert_eq!("pkg:type/name", &parsed.to_string());
    }

    #[test]
    fn parse_when_qualifiers_contains_checksums_normalizes_them() {
        let parsed =
            GenericPurl::<String>::from_str("pkg:type/name?checksum=hash2:12345678,HASH1:aAbBcCdD")
                .unwrap();
        assert_eq!("pkg:type/name?checksum=hash1:aabbccdd,hash2:12345678", &parsed.to_string());
    }

    #[test]
    fn parse_when_checksum_contains_invalid_hex_char_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:type/name?checksum=hash1:xx").unwrap_err();
        assert!(matches!(error, ParseError::InvalidQualifier));
    }

    #[test]
    fn parse_when_checksum_is_malformed_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:type/name?checksum=hash1").unwrap_err();
        assert!(matches!(error, ParseError::InvalidQualifier));
    }

    #[test]
    fn parse_when_checksum_is_duplicated_returns_error() {
        let error = GenericPurl::<String>::from_str("pkg:type/name?checksum=hash1:00,HASH1:11")
            .unwrap_err();
        assert!(matches!(error, ParseError::InvalidQualifier));
    }

    #[test]
    fn parse_parses_fields() {
        let purl =
            GenericPurl::<String>::from_str("pkg:type/namespace/name@version?key=value#subpath")
                .unwrap();
        assert_eq!("type", purl.package_type());
        assert_eq!(Some("namespace"), purl.namespace());
        assert_eq!("name", purl.name());
        assert_eq!(Some("version"), purl.version());
        assert_eq!(Some("value"), purl.qualifiers().get("key"));
        assert_eq!(Some("subpath"), purl.subpath());
    }

    #[cfg(feature = "serde")]
    #[test]
    fn deserialize_deserializes_correctly() {
        use serde::de::IntoDeserializer;
        use serde::Deserialize;

        let deserialized = GenericPurl::<String>::deserialize(IntoDeserializer::<
            serde::de::value::Error,
        >::into_deserializer(
            "pkg:type/name".to_owned()
        ))
        .unwrap();
        assert_eq!(GenericPurl::<String>::from_str("pkg:type/name").unwrap(), deserialized,);
    }
}
