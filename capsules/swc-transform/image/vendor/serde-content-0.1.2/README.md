# Serde data model

`serde-content` is an alternative design for the private Serde content types
[like this one](https://github.com/serde-rs/serde/blob/v1.0.11/serde/src/private/de.rs#L236-L265).
These types are used to store the Rust values that represent the Serde data model.
The model is stable and [well documented](https://serde.rs/data-model.html).

This crate offers a unified design for both serialising and deserialising data.
The goal is to offer a stable interface with roundtrip guarantees when
serialising to and deserialising from `Value` using our `Serializer` and `Deserializer`.

## Example

```rust
use serde::{Deserialize, Serialize};
use serde_content::{Deserializer, Serializer};

#[derive(Debug, Serialize, Deserialize)]
struct Point {
    x: i32,
    y: i32,
}

fn main() -> serde_content::Result<()> {
    let point = Point { x: 1, y: 2 };

    // Convert the Point to the Value type.
    let serialized = Serializer::new().serialize(&point)?;

    // Pretty print the serialised Value.
    dbg!(&serialized);

    // Convert the Value back to a Point.
    let deserialized: Point = Deserializer::new(serialized).deserialize()?;

    // Pretty print the deserialised Point.
    dbg!(deserialized);

    Ok(())
}
```

## License

<sup>
Licensed under either of <a href="LICENSE-APACHE">Apache License, Version
2.0</a> or <a href="LICENSE-MIT">MIT license</a> at your option.
</sup>

<br>

<sub>
Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in Serde by you, as defined in the Apache-2.0 license, shall be
dual licensed as above, without any additional terms or conditions.
</sub>
