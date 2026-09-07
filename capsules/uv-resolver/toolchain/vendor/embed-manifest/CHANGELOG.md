# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://doc.rust-lang.org/cargo/reference/semver.html).

## [1.5.0] - 2025-11-23
### Changed
- Update minimum supported Rust version to 1.85.0 and epoch to 2024,
  adding `unsafe` where now required.
- Update dev dependencies and formatting, and fix new Clippy warnings.
- Remove documentation referring to Cargo support for `link-arg` and
  Rust tier 1 support for Windows 7. The Windows version support in
  the default generated manifest remains the same.
### Removed
- Inline assembly XML manifest example moved to
  [carey/asmmanifest](https://codeberg.org/carey/asmmanifest).
### Fixed
- Output multiple dependent assemblies correctly. This is technically
  a breaking change, but this functionality was previously broken anyway.
- Fix version number for `Cargo.toml` in `lib.rs` documentation.

## [1.4.0] - 2023-06-22
### Added
- Use `empty_manifest()` to start from a manifest with no default values.
  Fixes [issue #6](https://gitlab.com/careyevans/embed-manifest/-/issues/6).
### Fixed
- Generate an object file with a single `.rsrc` section on GNU targets.
  This lets it replace the default manifest from MinGW build tools.
  Fixes [issue #5](https://gitlab.com/careyevans/embed-manifest/-/issues/5).

## [1.3.1] - 2022-08-07
### Added
- Format the code with Rustfmt.
- Assume `gnullvm` target environment should work like `gnu`.
- Add Windows 11 22H2 SDK version for maxversiontested.
### Changed
- Update `object` dependency and simplify unit tests.

## [1.3.0] - 2022-05-01
### Changed
- Use our own code again to generate COFF object files for GNU targets, but with
  better knowledge of how such files are structured, reducing dependencies and
  compile time.
- Link directly to the COFF object file instead of an archive file with one member.
### Fixed
- Make the custom `Error` type public.

## [1.2.1] - 2022-04-18
### Added
- Add checks for Windows builds to the documentation, for programs that
  should still build for non-Windows targets.

## [1.2.0] - 2022-04-17
### Added
- Generate the manifest XML from Rust code rather than requiring the developer
  to supply a correct manifest file.

## [1.1.0] - 2022-03-24
### Changed
- Use [Gimli Object](https://crates.io/crates/object) crate to build COFF
  objects containing resources for GNU targets, removing a lot of magic numbers
  and generating output more like LLVM `windres`.

## [1.0.0] - 2021-12-18
### Added
- Initial version.

[1.0.0]: https://codeberg.org/carey/embed-manifest/releases/tag/v1.0.0
[1.1.0]: https://codeberg.org/carey/embed-manifest/compare/v1.0.0..v1.1.0
[1.2.0]: https://codeberg.org/carey/embed-manifest/compare/v1.1.0..v1.2.0
[1.2.1]: https://codeberg.org/carey/embed-manifest/compare/v1.2.0..v1.2.1
[1.3.0]: https://codeberg.org/carey/embed-manifest/compare/v1.2.1..v1.3.0
[1.3.1]: https://codeberg.org/carey/embed-manifest/compare/v1.3.0..v1.3.1
[1.4.0]: https://codeberg.org/carey/embed-manifest/compare/v1.3.1..v1.4.0
[1.5.0]: https://codeberg.org/carey/embed-manifest/compare/v1.4.0..v1.5.0
