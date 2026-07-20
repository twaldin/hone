# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1](https://github.com/TrueLayer/retry-policies/compare/v0.5.0...v0.5.1) - 2025-05-14

### Changed

- Improved bounded jitter to use 50% of `min_retry_interval` instead of 100%.

## [0.5.0](https://github.com/TrueLayer/retry-policies/compare/v0.4.0...v0.5.0) - 2025-05-14

### Changed

- [Breaking] Renamed `build_with_total_retry_duration_and_max_retries` to `build_with_total_retry_duration_and_limit_retries`.

### Added

- Added `build_with_total_retry_duration_and_max_retries`.

## [0.4.0](https://github.com/TrueLayer/retry-policies/compare/v0.3.0...v0.4.0) - 2024-05-10

### Changed

- [Breaking] Replace `chrono` with standard library types
  - Replace `chrono::DateTime<Utc>` with `std::time::SystemTime`

### Removed

- Remove unused `anyhow` dependency
- Remove `fake` dependency

## [0.3.0] - 2024-03-04

- [Breaking] Implement `RetryPolicy` for `ExponentialBackoffTimed`, which requires a modification to the `should_retry` method of
    `RetryPolicy` in order to pass the time at which the task (original request) was started.

## [0.2.1] - 2023-10-09

### Added

- Total duration algorithm can now be configured to also consider max retries, calculated applying no jitter (1.0)
  - We enforce whatever comes first, total duration or max retries
- Exponential base is now configurable

## [0.2.0] - 2023-07-21

### Changed

- [Breaking] Change backoff and jitter algorithms
  - Change the backoff algorithm to a more conventional exponential backoff.
  - Replace the decorrelated jitter algorithm with an option of either none, full, or bounded. Defaults to full jitter.
- [Breaking] Remove `ExponentialBackoffBuilder::backoff_exponent()`
  - The number of attempts is now used as the exponent.
- [Breaking] Require a task start time when using a total retry duration
  - `ExponentialBackoffBuilder::build_with_total_retry_duration()` now returns `ExponentialBackoffTimed` which does not implement `RetryPolicy`.
- [Breaking] Mark `ExponentialBackoff` as `non_exhaustive`
  - Can no longer be constructed directly.

## [0.1.2] - 2022-10-28

### Added

- `Debug` derived for `RetryDecision`

## [0.1.1] - 2021-10-18

### Security

- remove time v0.1 dependency

## [0.1.0] - 2021-08-11

### Added

- `ExponentialBackoff` policy.
