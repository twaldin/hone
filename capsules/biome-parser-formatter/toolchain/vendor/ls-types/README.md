# ls-types

[![CI][ci-badge]][ci-url]
[![Crates.io][crates-badge]][crates-url]
[![Documentation][docs-badge]][docs-url]

[ci-badge]: https://github.com/tower-lsp-community/ls-types/actions/workflows/rust.yml/badge.svg?branch=main
[ci-url]: https://github.com/tower-lsp-community/ls-types/actions
[crates-badge]: https://img.shields.io/crates/v/ls-types.svg
[crates-url]: https://crates.io/crates/ls-types
[docs-badge]: https://docs.rs/ls-types/badge.svg
[docs-url]: https://docs.rs/ls-types

*A fork of [lsp-types](https://github.com/gluon-lang/lsp-types)*

- [Projects using `ls-types`](#projects-using-ls-types)
- [Contributing](#contributing)
- [License](#license)


Types for the [Language Server Protocol] (*LSP*) specification and the [Language Server Index Format] (*LSIF*) specification.

[Language Server Protocol]: https://microsoft.github.io/language-server-protocol/
[Language Server Index Format]: https://microsoft.github.io/language-server-protocol/specifications/lsif/0.6.0/specification/

Supports LSP version [*3.17*]. Proposed version [*3.18*] features can be activated using the `proposed` feature flag.
> **NOTE** that these are unstable and may change between releases.

[*3.17*]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification
[*3.18*]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification

# Projects using `ls-types`

- [tower-lsp-server](https://github.com/tower-lsp-community/tower-lsp-server)

# Contributing

If you are making a change which adds, removes or modifies the LSP API it is highly appreciated if you link to the spec where this change is described. This gives context to whether the change should be an experimental addition and lets the reviewer easily double check the changes against the spec.

# License

`ls-types` is free and open source software distributed under the terms of either the [MIT](LICENSE-MIT) or the [Apache 2.0](LICENSE-APACHE) license, at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
