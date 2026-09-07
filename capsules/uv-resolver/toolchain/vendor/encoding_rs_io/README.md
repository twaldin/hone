encoding_rs_io
==============
This crate provides streaming adapters for the
[`encoding_rs`](https://github.com/hsivonen/encoding_rs)
crate. Adapters implement the standard library I/O traits and provide streaming
transcoding support.

[![Build status](https://github.com/BurntSushi/encoding_rs_io/workflows/ci/badge.svg)](https://github.com/BurntSushi/encoding_rs_io/actions)
[![](http://meritbadge.herokuapp.com/encoding_rs_io)](https://crates.io/crates/encoding_rs_io)


### Documentation

https://docs.rs/encoding_rs_io


### Usage

Add this to your `Cargo.toml`:

```toml
[dependencies]
encoding_rs_io = "0.1"
```

and this to your crate root:

```rust
extern crate encoding_rs_io;
```


### Example

This example shows how to create a decoder that transcodes UTF-16LE (the
source, indicated by a BOM) to UTF-8 (the destination).

```rust
extern crate encoding_rs;
extern crate encoding_rs_io;

use std::error::Error;
use std::io::Read;

use encoding_rs_io::DecodeReaderBytes;

fn main() {
    example().unwrap();
}

fn example() -> Result<(), Box<Error>> {
    let source_data = &b"\xFF\xFEf\x00o\x00o\x00b\x00a\x00r\x00"[..];
    // N.B. `source_data` can be any arbitrary io::Read implementation.
    let mut decoder = DecodeReaderBytes::new(source_data);

    let mut dest = String::new();
    // decoder implements the io::Read trait, so it can easily be plugged
    // into any consumer expecting an arbitrary reader.
    decoder.read_to_string(&mut dest)?;
    assert_eq!(dest, "foobar");
    Ok(())
}
```


### Future work

Currently, this crate only provides a way to get _possibly valid_ UTF-8 from
some source encoding. There are other transformations that may be useful that
we could include in this crate. Namely:

* An encoder that accepts an arbitrary `std::io::Write` implementation and
  takes valid UTF-8 and transcodes it to a selected destination encoding. This
  encoder would implement `std::fmt::Write`.
* A decoder that accepts an arbitrary `std::fmt::Write` implementation and
  takes arbitrary bytes and transcodes them from a selected source
  encoding to valid UTF-8. This decoder would implement `std::io::Write`.
* An encoder that accepts an arbitrary `UnicodeRead` implementation and
  takes valid UTF-8 and transcodes it to a selected destination encoding.
  This encoder would implement `std::io::Read`.
* A decoder that accepts an arbitrary `std::io::Read` implementation and
  takes arbitrary bytes and transcodes them from a selected source encoding
  to valid UTF-8. This decoder would implement the `UnicodeRead` trait.

Where `UnicodeRead` is a hypothetical trait that does not yet exist. Its
definition might look something like this:

```ignore
trait UnicodeRead {
    fn read(&mut self, buf: &mut str) -> Result<usize>;
}
```

Interestingly, of the above transformations, none of them correspond to
`DecodeReaderBytes`. Namely, `DecodeReaderBytes` most closely corresponds to
the last option, but instead of guaranteeing valid UTF-8 by implementing a
trait like `UnicodeRead`, it instead implements `std::io::Read`, which pushes
UTF-8 handling on to the caller. However, it turns out that this particular
use case is important for operations like search, which can often be written
in a way that don't assume UTF-8 validity but still benefit from it.

It's not clear which of the above transformations is actually useful, but all
of them could theoretically exist. There is more discussion on this topic
here (and in particular, the above formulation was taken almost verbatim from
Simon Sapin's comments): https://github.com/hsivonen/encoding_rs/issues/8

It is also perhaps worth stating that this crate very much intends on
remaining coupled to `encoding_rs`, which helps restrict the scope, but may be
too biased toward Web oriented encoding to solve grander encoding challenges.
As such, it may very well be that this crate is actually a stepping stone to
something with a larger scope. But first, we must learn.


### License

This project is licensed under either of

 * Apache License, Version 2.0, ([LICENSE-APACHE](LICENSE-APACHE) or
   http://www.apache.org/licenses/LICENSE-2.0)
 * MIT license ([LICENSE-MIT](LICENSE-MIT) or
   http://opensource.org/licenses/MIT)

at your option.
