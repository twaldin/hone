#![cfg(feature = "derive")]

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
