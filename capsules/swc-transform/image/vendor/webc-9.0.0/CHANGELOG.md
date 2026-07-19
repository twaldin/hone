# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changelog entries will contain a link to the pull request implementing that
change, where applicable.

<!-- next-header -->

## [5.9.0](https://github.com/wasmerio/pirita/compare/webc-v5.8.1...webc-v5.9.0) (2024-01-19)


### Features

* Added documentation for the `webc` crate's feature flags ([a024529](https://github.com/wasmerio/pirita/commit/a0245293ad2ec7483dce1e6e2d984ee1e0d915cc))
* Parsers for the `v1` and `v2` binary formats are now behind (enabled-by-default) feature flags ([4f7da5e](https://github.com/wasmerio/pirita/commit/4f7da5e54ab6f34676b39d70082e300ce1be4ff0))
* Switched the `[features`] table over to using the `dep:` format for dependency ([2b6c8fd](https://github.com/wasmerio/pirita/commit/2b6c8fd99cbb5e70af83a634c99fb1a6aca7f563))


### Bug Fixes

* Fix the conditional compilation in `container.rs` so all combinations of feature flags will compile ([f6fa355](https://github.com/wasmerio/pirita/commit/f6fa355f73cd6ed82ab148b14cbe5d4311962254))
* Made `wasmer-toml` a required dependency to fix `--no-default-features` builds ([91ac00c](https://github.com/wasmerio/pirita/commit/91ac00c58490a7b91e3201b0f684e67e1ace04f8))
* Trying to parse a tarball or Wasmer package directory without the `package` feature enabled will now return a `FeatureNotEnabled` error ([f6fa355](https://github.com/wasmerio/pirita/commit/f6fa355f73cd6ed82ab148b14cbe5d4311962254))

## [5.8.1](https://github.com/wasmerio/pirita/compare/webc-v5.8.0...webc-v5.8.1) (2023-11-22)


### Features

* Temporarily exposed some private APIs for use in the `wasmer` CLI. ([0372944](https://github.com/wasmerio/pirita/commit/037294427bd0f4418a3907372beaafd8da35d0eb))

## [5.8.0](https://github.com/wasmerio/pirita/compare/webc-v5.7.0...webc-v5.8.0) (2023-11-01)


### Features

* Unpack containers and volumes into local directories ([2a767a2](https://github.com/wasmerio/pirita/commit/2a767a238417ac3ec02e89bd1344239717f790e6))

## [5.7.0](https://github.com/wasmerio/pirita/compare/webc-v5.6.0...webc-v5.7.0) (2023-10-25)


### Features

* The `Container::from_disk()` constructor can now load Wasmer packages when given a directory ([d9837e0](https://github.com/wasmerio/pirita/commit/d9837e0b5ddbfa2a3ea979bccf0634c33cf314e6))

## [5.6.0](https://github.com/wasmerio/pirita/compare/webc-v5.5.1...webc-v5.6.0) (2023-10-09)


### Features

* Packages can be marked as private using the "private" flag on a package's "wapm" annotations ([c160ccc](https://github.com/wasmerio/pirita/commit/c160ccc107d8af4c8f714854330b61696d9ffeda))
* Upgraded the `wasmer-toml` dependency so tarballs and packages on disk can be marked as "private" using the "private" key under "[package]" ([876b883](https://github.com/wasmerio/pirita/commit/876b883aa9ba9d7a5445fc3091194b347e24e8b2))


### Bug Fixes

* Allow tarballs with a leading "./" ([8d54a7c](https://github.com/wasmerio/pirita/commit/8d54a7c043b60cfe2ec9944555518ef955f87b53))

## [5.5.1](https://github.com/wasmerio/pirita/compare/webc-v5.5.0...webc-v5.5.1) (2023-09-20)


### Bug Fixes

* The "module" and "dependency" fields in atom annotations were the wrong way around ([7be2ef9](https://github.com/wasmerio/pirita/commit/7be2ef95e98e020fe5860e738e64fd81f516fad2))
* Wasmer package conversion now uses a dependency's full name as the alias, rather than just the package name ([2f66d0f](https://github.com/wasmerio/pirita/commit/2f66d0f8f42661c203dcd2eb058d3b4f5ac3ca05))

## [5.5.0](https://github.com/wasmerio/pirita/compare/webc-v5.4.0...webc-v5.5.0) (2023-09-19)


### Features

* Deprecated the "atom" field in our "wasi" and "emscripten" annotations ([326d108](https://github.com/wasmerio/pirita/commit/326d10807822edf728c6f985e147da0faaeb7d3a))
* Introduced an "atom" command annotation ([ec8f6b8](https://github.com/wasmerio/pirita/commit/ec8f6b8683ab233a35ede6a5562230199e51910b))
* Loading Wasmer packages from a tarball or disk now sets the "atom" command annotations ([0d3e663](https://github.com/wasmerio/pirita/commit/0d3e663a7893ae9e163b28dc2775588810438423))
* Made the `webc::v2::Span`'s `with_offset()` method public ([30ccddb](https://github.com/wasmerio/pirita/commit/30ccddb3b9cf88cfccc9ae2a91a824b5016dbb0e))
* Polyfill the "atom" command annotation based on deprecated fields ([3794020](https://github.com/wasmerio/pirita/commit/3794020587c0c2a149407d8daf017da539f762c7))

## [5.4.0](https://github.com/wasmerio/pirita/compare/webc-v5.3.0...webc-v5.4.0) (2023-09-13)


### Features

* Expose file and volume offsets when parsing the v2 binary format ([#170](https://github.com/wasmerio/pirita/issues/170)) ([60f414d](https://github.com/wasmerio/pirita/commit/60f414d35cb5da6b37cc87ed214d7b9b09d8a822))
* Made a file entry's SHA-256 checksum accessible when reading volumes from a v2 webc file ([60f414d](https://github.com/wasmerio/pirita/commit/60f414d35cb5da6b37cc87ed214d7b9b09d8a822))


### Bug Fixes

* Fixed a broken docs link in `webc::wasmer_package::Strictness` ([60f414d](https://github.com/wasmerio/pirita/commit/60f414d35cb5da6b37cc87ed214d7b9b09d8a822))

## [5.3.0](https://github.com/wasmerio/pirita/compare/webc-v5.2.2...webc-v5.3.0) (2023-08-02)


### Features

* Introduced "strictness" to the `webc::wasmer_package` module to allow users to ignore partially invalid packages ([eb78e7d](https://github.com/wasmerio/pirita/commit/eb78e7da4124f8a0a023dd62cae81a4c41f00d28))
* The `wapm2pirita convert` command now allows the package to be slightly invalid (use "--strict" to get the old behaviour) ([4e3752d](https://github.com/wasmerio/pirita/commit/4e3752d5fda09fb079fa87fa04de02c2fc6504da))


### Bug Fixes

* Allow custom annotations to be merged with automatically generated annotations when they are both the same primitive value ([30d2b4e](https://github.com/wasmerio/pirita/commit/30d2b4edfb71743eff7c1a2c17dc8494ff377e7e))

## [5.2.2](https://github.com/wasmerio/pirita/compare/webc-v5.2.1...webc-v5.2.2) (2023-07-27)


### Bug Fixes

* Removed a dbg!() that was accidentally left in the code ([a663d40](https://github.com/wasmerio/pirita/commit/a663d40f9a68fc08b19b3ce9ef88ba5684a0bfae))
* Removed a todo!() that was accidentally left in the code ([546017f](https://github.com/wasmerio/pirita/commit/546017f78cdb8ddc9037d60b904a94060a4a5778))

## [5.2.1](https://github.com/wasmerio/pirita/compare/webc-v5.2.0...webc-v5.2.1) (2023-07-26)


### Bug Fixes

* Added polyfills to the `webc::wasmer_package` module to allow consuming tarballs in a WASI environment ([ba16852](https://github.com/wasmerio/pirita/commit/ba168528433564acb8908b4ce25c82cfab78a0d5))
* Made some more error variants propagate their underlying errors ([7c22e09](https://github.com/wasmerio/pirita/commit/7c22e0996f941d8b34504f197c25c22499f9d759))

## [5.2.0](https://github.com/wasmerio/pirita/compare/webc-v5.1.1...webc-v5.2.0) (2023-07-24)


### Features

* Added support for the "package.entrypoint" field in "wasmer.toml" (closes [#155](https://github.com/wasmerio/pirita/issues/155)) ([c6f3f0e](https://github.com/wasmerio/pirita/commit/c6f3f0e946d646ad0efada93831f52a2d4a87853))

## [5.1.1](https://github.com/wasmerio/pirita/compare/webc-v5.1.0...webc-v5.1.1) (2023-07-20)


### Bug Fixes

* Add support for Wasmer package commands that have "abi = none" ([0c38a77](https://github.com/wasmerio/pirita/commit/0c38a77d4081b392a8f8bce505c898fdeb209a7b))

## [5.1.0](https://github.com/wasmerio/pirita/compare/webc-v5.0.4...webc-v5.1.0) (2023-07-20)


### Features

* Explicitly specified command runners are no longer overridden by the "module.abi" field ([a3e1e40](https://github.com/wasmerio/pirita/commit/a3e1e405862c61bd619fc9d8c8b07b4c66caa5b7)), closes [#124](https://github.com/wasmerio/pirita/issues/124)
* Added a `webc::wasmer_package` module for lazily loading a Wasmer package from disk and using it as a webc
* A webc::Container now supports downcasting ([84ac898](https://github.com/wasmerio/pirita/commit/84ac898640fe20150f3b407acdc95c158949b200))
* Added conversions to webc::Container for common backing implementations ([78093b8](https://github.com/wasmerio/pirita/commit/78093b8bb38df6be8826109bb9ad4f535b8a5eb9))
* The version-agnostic Container and Volume abstractions are now exported from the top level and the `webc::compat` module has been deprecated ([a732d4e](https://github.com/wasmerio/pirita/commit/a732d4ed352bea67081e7af9d949c662560dee33))


### Bug Fixes

* **webc,wapm-to-webc:** Absolute paths in wasmer.toml are now translated to a volume-specific path in the webc manifest (fixes [#105](https://github.com/wasmerio/pirita/issues/105)) ([d64c0cc](https://github.com/wasmerio/pirita/commit/d64c0cc4b000fcd7579627682fe70b9d38566aff))

## [Unreleased] - ReleaseDate

## [5.0.4] - 2023-06-08

### Changed

- The `FileSystemMapping` now contains an `original_path` field, allowing
  consumers to mount individual directories from a volume, rather than being
  forced to mount the entire volume
  ([#127](https://github.com/wasmerio/pirita/pull/127))

## [5.0.3] - 2023-06-06

### Added

- Added a `FileSystemMappings` package annotation for declaring how volumes
  should be mapped when instantiating a package
  ([#119](https://github.com/wasmerio/pirita/pull/119))
- Added getter methods for well-known package and command annotations
  ([#119](https://github.com/wasmerio/pirita/pull/119))

### Changed

- Abstracted the logic for `webc::compat::SharedBytes` out into its own crate
  ([#114](https://github.com/wasmerio/pirita/pull/114))

## [5.0.2] - 2023-05-28

### Fixed

- Fixed a bug where the compatibility layer would panic when reading a
  zero-length atom from a v1 WEBC file
  ([#117](https://github.com/wasmerio/pirita/pull/117))

## [5.0.1] - 2023-05-27

### Fixed

- For v2 WEBC files, the compatibility layer was returning the wrong names from
  `Container::volume_names()`
  ([#115](https://github.com/wasmerio/pirita/pull/115))


## [5.0.0] - 2023-04-18

<!-- next-url -->
[Unreleased]: https://github.com/wasmerio/pirita/compare/webc-v5.0.4...HEAD
[5.0.4]: https://github.com/wasmerio/pirita/compare/webc-v5.0.3...webc-v5.0.4
[5.0.3]: https://github.com/wasmerio/pirita/compare/webc-v5.0.2...webc-v5.0.3
[5.0.1]: https://github.com/wasmerio/pirita/compare/webc-v5.0.0..webc-v5.0.1
[5.0.1]: https://github.com/wasmerio/pirita/compare/webc-v5.0.0..webc-v5.0.1
