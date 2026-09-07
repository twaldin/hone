use crate::qualifiers::well_known::{Checksum, KnownQualifierKey};
use crate::{GenericPurl, ParseError, PurlParts, PurlShape, SmallString};

/// A mutable, potentially invalid PURL.
///
/// This type is used while parsing or constructing PURLs.
/// [`GenericPurlBuilder::build`] converts the builder into an immutable,
/// validated PURL.
///
/// # Example
///
/// ```
/// use purl::GenericPurlBuilder;
///
/// // Use the builder if you want to set fields besides the type and name.
/// let purl = GenericPurlBuilder::new(String::from("maven"), "my-package")
///     .with_namespace("my.company")
///     .build()
///     .unwrap();
///
/// assert_eq!("pkg:maven/my.company/my-package", &purl.to_string());
/// ```
#[derive(Clone, Debug, Default)]
#[must_use]
pub struct GenericPurlBuilder<T> {
    /// The package type.
    pub package_type: T,
    /// The type-specific parts that make up the PURL.
    pub parts: PurlParts,
}

impl<T> GenericPurlBuilder<T> {
    /// Initialize a new PURL builder.
    pub fn new<S>(package_type: T, name: S) -> Self
    where
        SmallString: From<S>,
    {
        Self {
            package_type,
            parts: PurlParts { name: SmallString::from(name), ..Default::default() },
        }
    }

    /// Set the package type.
    pub fn with_package_type(mut self, new: T) -> Self {
        self.package_type = new;
        self
    }

    /// Set the namespace.
    ///
    /// Passing `""` unsets the namespace.
    pub fn with_namespace<S>(mut self, new: S) -> Self
    where
        SmallString: From<S>,
    {
        self.parts.namespace = SmallString::from(new);
        self
    }

    /// Unset the namespace.
    ///
    /// This is the same as passing `""` to [`Self::with_namespace`].
    pub fn without_namespace(mut self) -> Self {
        self.parts.namespace = Default::default();
        self
    }

    /// Set the name.
    pub fn with_name<S>(mut self, new: S) -> Self
    where
        SmallString: From<S>,
    {
        self.parts.name = SmallString::from(new);
        self
    }

    /// Set the version.
    ///
    /// Passing `""` unsets the version.
    pub fn with_version<S>(mut self, new: S) -> Self
    where
        SmallString: From<S>,
    {
        self.parts.version = SmallString::from(new);
        self
    }

    /// Unset the version.
    ///
    /// This is the same as passing `""` to [`Self::with_version`].
    pub fn without_version(mut self) -> Self {
        self.parts.version = Default::default();
        self
    }

    /// Set a qualifier.
    ///
    /// If `v` is `""`, the qualifier will be unset.
    pub fn with_qualifier<K, V>(mut self, k: K, v: V) -> Result<Self, ParseError>
    where
        K: AsRef<str>,
        SmallString: From<K> + From<V>,
    {
        self.parts.qualifiers.insert(k, v)?;
        Ok(self)
    }

    /// Set a qualifier.
    ///
    /// If `v` is `None`, the qualifier will be unset.
    pub fn with_typed_qualifier<Q>(mut self, v: Option<Q>) -> Self
    where
        Q: KnownQualifierKey,
        SmallString: From<Q>,
    {
        match v {
            Some(v) => {
                self.parts.qualifiers.insert_typed(v);
            },
            None => {
                self.parts.qualifiers.remove_typed::<Q>();
            },
        }
        self
    }

    /// Set a qualifier.
    ///
    /// If `v` is `None`, the qualifier will be unset.
    pub fn try_with_typed_qualifier<Q>(
        mut self,
        v: Option<Q>,
    ) -> Result<Self, <SmallString as TryFrom<Q>>::Error>
    where
        Q: KnownQualifierKey,
        SmallString: TryFrom<Q>,
    {
        match v {
            Some(v) => {
                self.parts.qualifiers.try_insert_typed(v)?;
            },
            None => {
                self.parts.qualifiers.remove_typed::<Q>();
            },
        }
        Ok(self)
    }

    /// Unset a qualifier.
    ///
    /// This is the same as passing `k, ""` to [`Self::with_qualifier`].
    pub fn without_qualifier<S>(mut self, k: S) -> Self
    where
        S: AsRef<str>,
    {
        self.parts.qualifiers.remove(k);
        self
    }

    /// Unset all qualifiers.
    pub fn without_qualifiers(mut self) -> Self {
        self.parts.qualifiers.clear();
        self
    }

    /// Set the subpath.
    ///
    /// Passing `""` will unset the subpath.
    pub fn with_subpath<S>(mut self, new: S) -> Self
    where
        SmallString: From<S>,
    {
        let new = SmallString::from(new);

        // PURL subpaths are forbidden to contain these segments.
        // The parsing spec says to remove them, so remove them here too.
        let new = if new.split('/').any(|segment| ["", ".", ".."].contains(&segment)) {
            let mut cleaned = SmallString::new();
            let mut segments = new.split('/').filter(|segment| !["", ".", ".."].contains(segment));
            if let Some(first) = segments.next() {
                cleaned.push_str(first);
                for rest in segments {
                    cleaned.push('/');
                    cleaned.push_str(rest);
                }
            }
            cleaned
        } else {
            new
        };

        self.parts.subpath = new;
        self
    }

    /// Unset the subpath.
    ///
    /// This is the same as passing `""` to [`Self::with_subpath`].
    pub fn without_subpath(mut self) -> Self {
        self.parts.subpath = Default::default();
        self
    }

    /// Convert the PURL builder into a PURL.
    ///
    /// The [`PurlShape::finish`] will be called on `T` to apply normalization
    /// and validation rules.
    pub fn build(mut self) -> Result<GenericPurl<T>, <T as PurlShape>::Error>
    where
        T: PurlShape,
    {
        self.package_type.finish(&mut self.parts)?;

        if self.parts.name.is_empty() {
            return Err(T::Error::from(ParseError::MissingRequiredField(crate::PurlField::Name)));
        }

        // Empty qualifiers are the same as unset qualifiers.
        self.parts.qualifiers.retain(|_, v| !v.is_empty());

        if let Some(checksum) = self.parts.qualifiers.try_get_typed::<Checksum>()? {
            // We can't just use `try_insert_typed` because we can't express to the borrow
            // checker that `Checksum<'a>`'s immutable borrow of `self.parts.qualifiers`
            // ends in the middle of `try_insert_typed` before the mutable borrow is
            // required.
            self.parts.qualifiers.insert(Checksum::KEY, SmallString::try_from(checksum)?)?;
        }

        let GenericPurlBuilder { package_type, parts } = self;

        Ok(GenericPurl { package_type, parts })
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use maplit::hashmap;

    use super::*;
    use crate::qualifiers::well_known::RepositoryUrl;
    use crate::qualifiers::Qualifiers;
    use crate::PurlField;

    #[test]
    fn with_package_type_sets_type() {
        let builder = GenericPurlBuilder { package_type: "old", parts: PurlParts::default() }
            .with_package_type("new");
        assert_eq!("new", builder.package_type);
    }

    #[test]
    fn with_namespace_some_sets_namespace() {
        let builder = GenericPurlBuilder::<&str>::default().with_namespace("new");
        assert_eq!("new", &builder.parts.namespace);
    }

    #[test]
    fn without_namespace_unsets_namespace() {
        let builder = GenericPurlBuilder {
            package_type: "",
            parts: PurlParts { namespace: "old".into(), ..Default::default() },
        }
        .without_namespace();
        assert_eq!("", &builder.parts.namespace);
    }

    #[test]
    fn with_name_sets_name() {
        let builder = GenericPurlBuilder::<&str>::default().with_name("new");
        assert_eq!("new", &builder.parts.name);
    }

    #[test]
    fn with_version_some_sets_version() {
        let builder = GenericPurlBuilder::<&str>::default().with_version("new");
        assert_eq!("new", &builder.parts.version);
    }

    #[test]
    fn without_version_unsets_version() {
        let builder = GenericPurlBuilder {
            package_type: "",
            parts: PurlParts { version: "old".into(), ..Default::default() },
        }
        .without_version();
        assert_eq!("", &builder.parts.version);
    }

    #[test]
    fn with_qualifier_with_new_valid_key_sets_qualifier() {
        let builder =
            GenericPurlBuilder { package_type: "", parts: PurlParts { ..Default::default() } }
                .with_qualifier("ok", "value")
                .unwrap();
        assert_eq!(
            hashmap! { "ok" => "value" },
            builder.parts.qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        )
    }

    #[test]
    fn with_qualifier_with_new_invalid_key_returns_error() {
        let result =
            GenericPurlBuilder { package_type: "", parts: PurlParts { ..Default::default() } }
                .with_qualifier("", "");
        assert!(matches!(result, Err(ParseError::InvalidQualifier)));
    }

    #[test]
    fn with_qualifier_with_existing_key_sets_qualifier() {
        let builder = GenericPurlBuilder {
            package_type: "",
            parts: PurlParts {
                qualifiers: Qualifiers::try_from_iter([("ok", "old")]).unwrap(),
                ..Default::default()
            },
        }
        .with_qualifier("ok", "new")
        .unwrap();
        assert_eq!(
            hashmap! { "ok" => "new" },
            builder.parts.qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        )
    }

    #[test]
    fn with_typed_qualifier_with_new_key_and_some_value_sets_qualifier() {
        let builder =
            GenericPurlBuilder { package_type: "", parts: PurlParts { ..Default::default() } }
                .with_typed_qualifier(Some(RepositoryUrl::from("example.com")));
        assert_eq!(
            hashmap! { RepositoryUrl::KEY => "example.com" },
            builder.parts.qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        )
    }

    #[test]
    fn with_typed_qualifier_with_existing_key_and_none_value_unsets_qualifier() {
        let builder = GenericPurlBuilder {
            package_type: "",
            parts: PurlParts {
                qualifiers: Qualifiers::try_from_iter([(RepositoryUrl::KEY, "example.com")])
                    .unwrap(),
                ..Default::default()
            },
        }
        .with_typed_qualifier(None::<RepositoryUrl>);
        assert_eq!(
            hashmap! {},
            builder.parts.qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        )
    }

    #[test]
    fn try_with_typed_qualifier_with_new_key_and_some_value_sets_qualifier() {
        let builder =
            GenericPurlBuilder { package_type: "", parts: PurlParts { ..Default::default() } }
                .try_with_typed_qualifier(Some(RepositoryUrl::from("example.com")))
                .unwrap();
        assert_eq!(
            hashmap! { RepositoryUrl::KEY => "example.com" },
            builder.parts.qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        )
    }

    #[test]
    fn try_with_typed_qualifier_with_existing_key_and_none_value_unsets_qualifier() {
        let builder = GenericPurlBuilder {
            package_type: "",
            parts: PurlParts {
                qualifiers: Qualifiers::try_from_iter([(RepositoryUrl::KEY, "example.com")])
                    .unwrap(),
                ..Default::default()
            },
        }
        .try_with_typed_qualifier(None::<RepositoryUrl>)
        .unwrap();
        assert_eq!(
            hashmap! {},
            builder.parts.qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        )
    }

    #[test]
    fn without_qualifier_with_existing_key_unsets_qualifier() {
        let builder = GenericPurlBuilder {
            package_type: "",
            parts: PurlParts {
                qualifiers: Qualifiers::try_from_iter([("ok", "old")]).unwrap(),
                ..Default::default()
            },
        }
        .without_qualifier("ok");
        assert_eq!(hashmap! {}, builder.parts.qualifiers.iter().collect())
    }

    #[test]
    fn with_subpath_some_sets_subpath() {
        let builder = GenericPurlBuilder::<&str>::default().with_subpath("new");
        assert_eq!("new", &builder.parts.subpath);
    }

    #[test]
    fn without_subpath_unsets_subpath() {
        let builder = GenericPurlBuilder {
            package_type: "",
            parts: PurlParts { subpath: "old".into(), ..Default::default() },
        }
        .without_subpath();
        assert_eq!("", &builder.parts.subpath);
    }

    #[test]
    fn with_subpath_some_normalizes_subpath() {
        let builder = GenericPurlBuilder::<&str>::default().with_subpath("/.././/...//.");
        assert_eq!("...", &builder.parts.subpath);
    }

    #[test]
    fn build_works() {
        let purl = GenericPurlBuilder::default()
            .with_package_type(Cow::Borrowed("type"))
            .with_namespace("namespace")
            .with_name("name")
            .with_version("version")
            .with_qualifier("key", "value")
            .unwrap()
            .with_subpath("subpath")
            .build()
            .expect("build failed");
        assert_eq!("type", purl.package_type().package_type());
        assert_eq!("name", purl.name());
        assert_eq!(Some("version"), purl.version());
        assert_eq!(Some("value"), purl.qualifiers().get("key"));
        assert_eq!(Some("subpath"), purl.subpath());
    }

    #[test]
    fn empty_package_name_is_invalid() {
        let error = GenericPurl::new("type".to_owned(), "").unwrap_err();
        assert!(matches!(error, ParseError::MissingRequiredField(PurlField::Name)));
    }
}
