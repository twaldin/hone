# retry-policies

A collection of plug-and-play retry policies for Rust projects.

[![Crates.io](https://img.shields.io/crates/v/retry-policies.svg)](https://crates.io/crates/retry-policies)
[![Docs.rs](https://docs.rs/retry-policies/badge.svg)](https://docs.rs/retry-policies)
[![CI](https://github.com/TrueLayer/retry-policies/workflows/CI/badge.svg)](https://github.com/TrueLayer/retry-policies/actions)
[![Coverage Status](https://coveralls.io/repos/github/TrueLayer/rust-retry-policies/badge.svg?branch=main&t=d56f4Y)](https://coveralls.io/github/TrueLayer/rust-retry-policies?branch=main)

Currently available algorithms:

- [`ExponentialBackoff`](https://docs.rs/retry-policies/latest/retry_policies/policies/struct.ExponentialBackoff.html),
  with configurable jitter.

## How to install

Add `retry-policies` to your dependencies

```toml
[dependencies]
# ...
retry-policies = "0.4.0"
```

## License

<!-- markdownlint-disable MD033 -->

<sup>
Licensed under either of <a href="LICENSE-APACHE">Apache License, Version
2.0</a> or <a href="LICENSE-MIT">MIT license</a> at your option.
</sup>

<br>

<sub>
Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in the work by you, as defined in the Apache-2.0 license, shall be
dual licensed as above, without any additional terms or conditions.
</sub>
