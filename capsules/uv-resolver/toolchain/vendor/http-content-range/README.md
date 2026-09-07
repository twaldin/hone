# http-content-range

[![GitHub repo](https://img.shields.io/badge/github-nyurik/http--content--range-8da0cb?logo=github)](https://github.com/nyurik/http-content-range)
[![crates.io version](https://img.shields.io/crates/v/http-content-range)](https://crates.io/crates/http-content-range)
[![crate usage](https://img.shields.io/crates/d/http-content-range)](https://crates.io/crates/http-content-range)
[![docs.rs status](https://img.shields.io/docsrs/http-content-range)](https://docs.rs/http-content-range)
[![crates.io license](https://img.shields.io/crates/l/http-content-range)](https://github.com/nyurik/http-content-range/blob/main/LICENSE-APACHE)
[![CI build status](https://github.com/nyurik/http-content-range/actions/workflows/ci.yml/badge.svg)](https://github.com/nyurik/http-content-range/actions)
[![Codecov](https://img.shields.io/codecov/c/github/nyurik/http-content-range)](https://app.codecov.io/gh/nyurik/http-content-range)

Tiny Rust lib to decode Content-Range response headers.

```rust
use http_content_range::ContentRange;

let value = ContentRange::parse("bytes 42-69/420");

match value.expect("Failed to parse Content-Range") {
    ContentRange::Bytes(r) => {
        println!(
            "First_byte={}, last_byte={}, complete_length={}",
            r.first_byte, r.last_byte, r.complete_length,
        );
    }
    ContentRange::UnboundBytes(r) => {
        println!(
            "First_byte={}, last_byte={}, complete_length is unknown",
            r.first_byte, r.last_byte
        );
    }
    ContentRange::Unsatisfied(r) => {
        println!(
            "Unsatisfied response, complete_length={}",
            r.complete_length
        );
    }
};
```

## Development

* This project is easier to develop with [just](https://github.com/casey/just#readme), a modern alternative to `make`.
  Install it with `cargo install just`.
* To get a list of available commands, run `just`.
* To run tests, use `just test`.

## Credits

The code was inspired by the [rust-http-range](https://github.com/bancek/rust-http-range) crate.

## License

Licensed under either of

* Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
* MIT license ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)
  at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in the work by you, as defined in the
Apache-2.0 license, shall be dual-licensed as above, without any
additional terms or conditions.
