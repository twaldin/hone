# Changelog

## [Unreleased]

## [0.0.2] - 2025-12-07

[0.0.2]: https://github.com/tower-lsp-community/ls-types/releases/tag/v0.0.2

## Fixed

- compile with feature proposed enabled

## [0.0.1] - 2025-12-07

[0.0.1]: https://github.com/tower-lsp-community/ls-types/releases/tag/v0.0.1

### Added

- add `From` and `DerefMut` trait to `Uri` (#16)
- add `to_file_path` and `from_file_path` to `Uri` (#17)
- add type conversions for `NumberOrString` (#20)
- add type conversions for `WorkspaceSymbolResponse` (#24)

### Fixed

- fix typo in `WorkspaceClientCapabilities` (#3)
- move `annotationId` from `DeleteFileOptions` to `DeleteFile` (#4)
- fix typo in `ReferenceOptions` name (#8)
- add `TextDocumentRegistrationOptions` struct (#10)
- improve item docs for `FoldingRange.{startLine,endLine}` (#11)
- add `labelSupport` to `DocumentSymbolClientCapabilities` (#12)
- add `DocumentSymbolRegistrationOptions` struct (#13)

---

Check [`lsp-types`'s changelog](https://github.com/gluon-lang/lsp-types/blob/master/CHANGELOG.md) for older versions.
