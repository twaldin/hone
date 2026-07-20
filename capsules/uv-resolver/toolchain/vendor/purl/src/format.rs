//! Support for converting a PURL to a string.

use std::fmt;

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

use crate::{is_valid_package_type, GenericPurl, PurlShape};

/// https://url.spec.whatwg.org/#fragment-percent-encode-set
const FRAGMENT: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'<').add(b'>').add(b'`');

/// https://url.spec.whatwg.org/#query-percent-encode-set
const QUERY: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'#').add(b'<').add(b'>');

/// https://url.spec.whatwg.org/#path-percent-encode-set
const PATH: &AsciiSet = &QUERY.add(b'?').add(b'`').add(b'{').add(b'}');

// https://github.com/package-url/purl-spec/blob/master/PURL-SPECIFICATION.rst#how-to-build-purl-string-from-its-components
// We mostly use the standard URL rules, but the PURL spec says '@' '?' '#' must
// be escaped except when used as a separator, and we do all the encoding in one
// pass so we need to include '%'.
const PURL_PATH: &AsciiSet = &PATH.add(b'@').add(b'?').add(b'#').add(b'%');
const PURL_PATH_SEGMENT: &AsciiSet = &PURL_PATH.add(b'/');
// For compatibility with PURL implementations that treat qualifiers as
// form-urlencoded, escape '+' as well.
const PURL_QUALIFIER: &AsciiSet =
    &QUERY.add(b'@').add(b'?').add(b'#').add(b'+').add(b'%').add(b'&');
const PURL_FRAGMENT: &AsciiSet = &FRAGMENT.add(b'@').add(b'?').add(b'#').add(b'%');

impl<T> fmt::Display for GenericPurl<T>
where
    T: PurlShape,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let package_type = self.package_type().package_type();

        if !is_valid_package_type(&package_type) {
            panic!("Invalid package type {:?}", &*package_type);
        }

        write!(
            f,
            "pkg:{}/",
            // The PURL spec says the type must _not_ be encoded.
            // Technically, it is encoded, but we validated that it doesn't contain any characters
            // that would require being encoded.
            package_type,
        )?;

        if let Some(namespace) = self.namespace() {
            // The namespace is multiple path components.
            write!(f, "{}/", utf8_percent_encode(namespace, PURL_PATH))?;
        }

        // The name is only one path segment.
        write!(f, "{}", utf8_percent_encode(self.name(), PURL_PATH_SEGMENT))?;

        if let Some(version) = self.version() {
            // The version is a continuation of the same path segment.
            write!(f, "@{}", utf8_percent_encode(version, PURL_PATH))?;
        }

        if !self.parts.qualifiers.is_empty() {
            let mut prefix = '?';
            for (k, v) in &self.parts.qualifiers {
                write!(
                    f,
                    "{}{}={}",
                    prefix,
                    utf8_percent_encode(k, PURL_QUALIFIER),
                    utf8_percent_encode(v, PURL_QUALIFIER),
                )?;
                prefix = '&';
            }
        }

        if let Some(subpath) = self.subpath() {
            write!(f, "#{}", utf8_percent_encode(subpath, PURL_FRAGMENT))?;
        }

        Ok(())
    }
}

#[cfg(feature = "serde")]
mod ser {
    use serde::Serialize;

    use super::*;

    impl<T> Serialize for GenericPurl<T>
    where
        T: PurlShape,
    {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            serializer.collect_str(self)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::*;
    use crate::{GenericPurlBuilder, ParseError, PurlParts};

    #[test]
    #[should_panic]
    fn display_disallows_invalid_package_types() {
        struct MyBadPackageType;

        // Properly implemented `PurlShape`s only return valid package types.
        // Even the included string-based implementations validate the package type in
        // the `finish` method.
        impl PurlShape for MyBadPackageType {
            type Error = ParseError;

            fn package_type(&self) -> Cow<str> {
                Cow::Borrowed("!")
            }

            fn finish(&mut self, _parts: &mut PurlParts) -> Result<(), Self::Error> {
                Ok(())
            }
        }

        match GenericPurlBuilder::new(MyBadPackageType, "name").build() {
            Ok(purl) => {
                _ = purl.to_string();
            },
            Err(error) => {
                // Don't use unwrap or the test will incorrectly pass if the purl cannot be
                // built.
                eprintln!("Unexpected error: {}", error);
            },
        }
    }

    #[test]
    fn display_encodes_namespace_correctly() {
        assert_eq!(
            "pkg:generic/a%23/b%3F/c%40/name",
            &GenericPurlBuilder::new(Cow::Borrowed("generic"), "name")
                .with_namespace("a#/b?/c@")
                .build()
                .expect("Could not build PURL")
                .to_string(),
        );
    }

    #[test]
    fn display_encodes_name_correctly() {
        assert_eq!(
            "pkg:generic/a%23%2Fb%3F%2Fc%40",
            &GenericPurlBuilder::new(Cow::Borrowed("generic"), "a#/b?/c@")
                .build()
                .expect("Could not build PURL")
                .to_string(),
        );
    }

    #[test]
    fn display_encodes_qualifiers_correctly() {
        assert_eq!(
            "pkg:generic/name?a=%23&b=%3F&c=%40",
            &GenericPurlBuilder::new(Cow::Borrowed("generic"), "name")
                .with_qualifier("a", "#")
                .expect("Could not set qualifier a")
                .with_qualifier("b", "?")
                .expect("Could not set qualifier b")
                .with_qualifier("c", "@")
                .expect("Could not set qualifier c")
                .build()
                .expect("Could not build PURL")
                .to_string(),
        );
    }

    #[test]
    fn display_encodes_subpath_correctly() {
        assert_eq!(
            "pkg:generic/name#a%23/b%3F/c%40",
            &GenericPurlBuilder::new(Cow::Borrowed("generic"), "name")
                .with_subpath("a#/b?/c@")
                .build()
                .expect("Could not build PURL")
                .to_string(),
        );
    }

    #[cfg(feature = "serde")]
    #[test]
    fn serialize_serializes_correctly() {
        use std::fmt::Display;

        use serde::Serialize;

        struct SerializeToFormatter(GenericPurl<String>);

        impl Display for SerializeToFormatter {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.serialize(f).unwrap();
                Ok(())
            }
        }

        let serialized =
            SerializeToFormatter(GenericPurl::new("type".to_owned(), "name").unwrap()).to_string();
        assert_eq!("pkg:type/name", &serialized);
    }
}
