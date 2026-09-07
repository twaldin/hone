# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0](https://github.com/astral-sh/async_http_range_reader/compare/v0.10.0...v0.11.0) - 2026-03-31

### Added

- Migrate off bisect ([#10](https://github.com/astral-sh/async_http_range_reader/pull/10))

### Other

- Merge upstream main ([#12](https://github.com/astral-sh/async_http_range_reader/pull/12))
- Switch async_zip dev-dependency to astral_async_zip
- Update rstest dev-dependency to 0.26
- Merge pull request #8 from astral-sh/konsti/bounds-checks
- Fix clippy
- release v0.10.0

## [0.10.0](https://github.com/astral-sh/async_http_range_reader/compare/v0.9.1...v0.10.0) - 2026-02-09

### Other

- Modernize release-plz setup
- Update thiserror and itertools
- Update lockfile
- Rustfmt
- Revert "update lib.rs set accept-encoding: identity to prevent double-compression"
- update lib.rs set accept-encoding: identity to prevent double-compression
- update README to reflect astral-forked package
- new clippy notes: port updates from prefix-dev/async_http_range_reader
- update reqwest to 0.13.1, reqwest-middleware to 0.5.0

## [0.9.1](https://github.com/prefix-dev/async_http_range_reader/compare/v0.9.0...v0.9.1) - 2024-11-12

### Other

- Update reqwest-middleware from 0.3.0 to 0.4.0 ([#21](https://github.com/prefix-dev/async_http_range_reader/pull/21))

## [0.9.0](https://github.com/prefix-dev/async_http_range_reader/compare/v0.8.0...v0.9.0) - 2024-10-28

### Other

- Update dependencies ([#19](https://github.com/prefix-dev/async_http_range_reader/pull/19))

## [0.8.0](https://github.com/prefix-dev/async_http_range_reader/compare/v0.7.1...v0.8.0) - 2024-05-06

### Fixed
- always use requested URL, rather than response URL ([#16](https://github.com/prefix-dev/async_http_range_reader/pull/16))

## [0.7.1](https://github.com/prefix-dev/async_http_range_reader/compare/v0.7.0...v0.7.1) - 2024-04-10

### Other
- Upgrade `reqwest` to v0.12.3 ([#12](https://github.com/prefix-dev/async_http_range_reader/pull/12))

## [0.7.0](https://github.com/prefix-dev/async_http_range_reader/compare/v0.6.1...v0.7.0) - 2024-02-23

### Added
- lint pr titles for better changelogs ([#7](https://github.com/prefix-dev/async_http_range_reader/pull/7))

### Fixed
- tests

### Other
- Allow extra headers to be attached to requests ([#9](https://github.com/prefix-dev/async_http_range_reader/pull/9))

## [0.6.1](https://github.com/prefix-dev/async_http_range_reader/compare/v0.6.0...v0.6.1) - 2024-02-17

### Added
- added releaze-pls to the repository.

### Other
- Propagate unsupported error when server returns 200 ([#5](https://github.com/prefix-dev/async_http_range_reader/pull/5))
