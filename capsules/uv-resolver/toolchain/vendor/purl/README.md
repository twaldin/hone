[PURL] parsing, manipulation, and formatting.

A PURL is an identifier that refers to a software package. For example,
`pkg:cargo/purl` refers to this package.

This library supports PURLs at two levels:

1. The shape and format of a PURL is implemented by [`GenericPurl`]. It is possible to work with package-type-agnostic PURLs by using types like `GenericPurl<String>`. (see also [package-url/purl-spec#38])
2. The behavior of package types is implemented by [`PackageType`] and combined with [`GenericPurl`] by the type alias [`Purl`]. This implementation differs slightly from the PURL specification (see [`PackageType`] for details). It is possible to implement different package-type-specific behaviors or support for different package types by implementing the [`PurlShape`] trait.

[PURL]: https://github.com/package-url/purl-spec
[package-url/purl-spec#38]: https://github.com/package-url/purl-spec/issues/38
[`GenericPurl`]: https://docs.rs/purl/0.1/purl/struct.GenericPurl.html
[`Purl`]: https://docs.rs/purl/0.1/purl/type.Purl.html
[`PackageType`]: https://docs.rs/purl/0.1/purl/enum.PackageType.html
[`PurlShape`]: https://docs.rs/purl/0.1/purl/trait.PurlShape.html

# Example

```rust
use std::str::FromStr;

use purl::GenericPurl;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let purl = GenericPurl::<String>::from_str(
        "pkg:NPM/@acme/example@1.2.3?Checksum=sha256:\
        E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855",
    )?;
    assert_eq!("npm", purl.package_type());
    assert_eq!(Some("@acme"), purl.namespace());
    assert_eq!("example", purl.name());
    assert_eq!(Some("1.2.3"), purl.version());
    // Normalization is performed during parsing.
    assert_eq!(
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        purl.qualifiers()["checksum"],
    );
    assert_eq!(
        "pkg:npm/%40acme/example@1.2.3?checksum=sha256:\
        e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        &purl.to_string(),
    );

    let purl = purl.into_builder().without_version().without_qualifier("checksum").build()?;
    assert_eq!("pkg:npm/%40acme/example", &purl.to_string(),);
    Ok(())
}
```

# Features

- package-type: [`PackageType`] and related types
- serde: PURLs can be serialized and deserialized from strings
- smartstring: The smartstring crate is used to reduce heap allocations
