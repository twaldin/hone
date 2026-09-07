# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.6] - 2025-06-28

### Fixed
 * Added `rust-version` to `Cargo.toml`.

## [0.3.5] - 2025-06-27

### Changed
 * Updated all dependencies.
 * Refactored `if let` chains using Rust 1.88.0.

## [0.3.4] - 2024-09-30

### Changed
 * Updated `nix` crate to latest version for compatibility.

## [0.3.3] - 2024-07-05

### Fixed
 * A minor unsoundness hole existed in the method used to allocate SID buffers on Windows.
   Specifically, it was not checked that more than zero bytes were to be allocated,
   and it was not checked that the pointer returned from `alloc` was non-null.

## [0.3.2] - 2024-07-04

### Fixed
 * Mistake in the documentation of the `windows-coinitialize` feature.

## [0.3.1] - 2024-07-04

### Fixed
 * The crate did not compile if `windows-coinitialize` was not set (on Windows).

## [0.3.0] - 2024-07-04

### Added
 * `GetHomeInstance` on Windows, for caching purposes.
 * A platform-agnostic interface for `UserIdentifier`.

### Changed
 * The variants of `GetHomeError` on Windows have been adapted to the new implementation.
 * The `UserIdentifier` type on Windows is now immutable.
 * The `windows-sys` dependency has been replaced with the `windows` crate, as `windows-sys`
   is lacking in a required type.
 * The `GetHomeInstance` type on Windows to cache the `IWbemServices` interface for multiple
   queries.
 * Renamed `get_home` and `get_my_home` to `home` and `my_home` respectively.
 * Moved and renamed `get_home_from_id`, `get_my_id`, and `get_id` into the `UserIdentifier` type.
 * Changed the technique used to present a platform-agnostic interface in the crate root to mimic
   that used in the Rust standard library.

### Removed
 * The `wmi` and `serde` dependencies have been removed.

## [0.2.1] - 2023-08-27

### Fixed
 * Documentation tests that would not compile have been fixed.

## [0.2.0] - 2023-08-27

### Added
 * `get_id`, `get_home_from_id`, and `get_my_id` functions.
 * A `UserIdentifier` type alias.

### Changed
 * The `get_my_home` implementation on Unix systems now checks
   the `$HOME` environment variable first before checking the `/etc/passwd`
   directory.

### Removed
 * The `check_env` feature flag.

## [0.1.0] - 2023-08-12
The first release of this crate.

[0.3.6]: https://github.com/ljtpetersen/homedir/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/ljtpetersen/homedir/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/ljtpetersen/homedir/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/ljtpetersen/homedir/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/ljtpetersen/homedir/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ljtpetersen/homedir/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ljtpetersen/homedir/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/ljtpetersen/homedir/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ljtpetersen/homedir/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ljtpetersen/homedir/releases/tag/v0.1.0
