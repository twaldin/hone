# homedir &emsp; [![Build Status]][actions] [![latest version]][crates.io] [![docs passing]][docs.rs]

[Build Status]: https://img.shields.io/github/actions/workflow/status/ljtpetersen/homedir/rust.yml
[actions]: https://github.com/ljtpetersen/homedir/actions
[latest version]: https://img.shields.io/crates/v/homedir
[crates.io]: https://crates.io/crates/homedir
[docs passing]: https://img.shields.io/docsrs/homedir
[docs.rs]: https://docs.rs/homedir/latest/homedir/

This crate exists to provide a portable method to getting any user's home
directory. The API is rather simple: there are two main functions,
`home` and `my_home`. The former can get the home directory
of any user provided you have their username. The latter can get the home
directory of the user executing this process.

If all that is necessary is the home directory of the user executing this process,
then other crates may be better options, such as
[`directories`](https://crates.io/crates/directories). As well, using the home directory to find the
documents, downloads, pictures, etc. directories may not be accurate.

This crate aims to work on both Windows and Unix systems. However,
Unix systems do not have a unified API. This crate may not work
on Unix systems which do not have the `getpwnam_r(3)`, `getpwuid_r(3)`,
and `getuid(2)` functions. As well, special care is necessary for Windows
programs which use the COM library in other places. See the "For Windows Users" section
in the crate documentation for more details.

## Usage
This crate is on [crates.io](https://crates.io/crates/homedir) and can be used by executing `cargo add homedir`
or adding the following to the dependencies in your `Cargo.toml` file.

```toml
[dependencies]
homedir = "0.3.6"
```

### Features
 * `windows-coinitialize` — This is enabled by default. On Windows, call `CoInitializeEx` if `CoCreateInstance` returns `CO_E_NOTINITIALIZED`.
 See the "For Windows Users" section of the documentation for details about `CoInitializeEx`.

The full documentation of the crate, including examples, is available on the [docs.rs](https://docs.rs/homedir) page.

## Licensing
Licensed under either of

 * Apache License, Version 2.0
   ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
 * MIT License
   ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.

## Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in the work by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.

Feel free to put a copyright header in your name in any files you contribute to.

## Copyright and Credits
Copyright (C) 2023-2025 James Petersen <m@jamespetersen.ca>.

In version `0.3.0`, the [`wmi-rs`](https://github.com/ohadravid/wmi-rs) crate was referenced when writing the
`homedir::windows::UserIdentifier::to_home`
function, though there may not be any resemblance now. Nevertheless, I felt it was important to properly credit them, hence I included
this statement here. The referenced repository is also licensed under APACHE and MIT, which are included in this repository.
