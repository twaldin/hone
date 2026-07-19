//! A container for the Serde data model.

#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]
#![cfg_attr(test, deny(warnings))]
#![deny(missing_docs, unused_imports)]

extern crate alloc;

mod de;
mod error;
mod number;
mod ser;
mod tests;

use alloc::borrow::Cow;
use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;

pub use error::Data as FoundData;
pub use error::Error;
pub use error::ErrorKind;
pub use error::Expected;
pub use error::Found;
pub use error::Result;
pub use number::Number;
#[cfg(feature = "serde")]
pub use {de::Deserializer, de::Unexpected, de::ValueVisitor, ser::Serializer};

/// Represents struct and enum data.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub enum Data<'a> {
    /// Represents unit structs and unit enum variants.
    Unit,
    /// Represents newtype structs and enum variants.
    NewType {
        /// The value of the newtype struct or enum variant.
        value: Value<'a>,
    },
    /// Represents tuple structs and enum variants.
    Tuple {
        /// The values of the tuple struct or enum variant.
        values: Vec<Value<'a>>,
    },
    /// Represents object-like structs and enum variants.
    Struct {
        /// A vector of field names and their values.
        fields: Vec<(Cow<'static, str>, Value<'a>)>,
    },
}

impl Data<'_> {
    /// Moves data where possible or otherwise clones it into an owned object.
    pub fn into_owned(self) -> Data<'static> {
        match self {
            Data::Unit => Data::Unit,
            Data::NewType { value } => Data::NewType {
                value: value.into_owned(),
            },
            Data::Tuple { values } => Data::Tuple {
                values: values.into_iter().map(Value::into_owned).collect(),
            },
            Data::Struct { fields } => Data::Struct {
                fields: fields
                    .into_iter()
                    .map(|(key, value)| (key, value.into_owned()))
                    .collect(),
            },
        }
    }
}

/// Struct and enum data type.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
#[cfg_attr(feature = "derive", derive(serde::Serialize, serde::Deserialize))]
pub enum DataType {
    /// Unit struct or unit enum variant.
    Unit,
    /// Newtype struct or enum variant.
    NewType,
    /// Tuple struct or enum variant.
    Tuple,
    /// Object-like struct or enum variant.
    Struct,
}

/// Represents a Rust struct.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub struct Struct<'a> {
    /// The name of the struct.
    pub name: Cow<'static, str>,
    /// The data of the struct.
    pub data: Data<'a>,
}

impl Struct<'_> {
    /// Moves data where possible or otherwise clones it into an owned object.
    pub fn into_owned(self) -> Struct<'static> {
        Struct {
            data: self.data.into_owned(),
            ..self
        }
    }
}

/// Represents a Rust enum.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub struct Enum<'a> {
    /// The name of the enum.
    pub name: Cow<'static, str>,
    /// The index of the enum variant.
    pub variant_index: u32,
    /// The name of the enum variant.
    pub variant: Cow<'static, str>,
    /// The data of the enum.
    pub data: Data<'a>,
}

impl Enum<'_> {
    /// Moves data where possible or otherwise clones it into an owned object.
    pub fn into_owned(self) -> Enum<'static> {
        Enum {
            data: self.data.into_owned(),
            ..self
        }
    }
}

/// Represents any valid Rust value.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub enum Value<'a> {
    /// Represents the Rust unit type, `()`.
    Unit,
    /// Represents a Rust boolean.
    Bool(bool),
    /// Represents any Rust number.
    Number(Number),
    /// Represents a Rust character.
    Char(char),
    /// Represents a Rust string.
    String(Cow<'a, str>),
    /// Represents a Rust byte array.
    Bytes(Cow<'a, [u8]>),
    /// Represents an array of Rust values.
    Seq(Vec<Value<'a>>),
    /// Represents a map of Rust values.
    Map(Vec<(Value<'a>, Value<'a>)>),
    /// Represents optional Rust values.
    Option(Option<Box<Value<'a>>>),
    /// Represents a Rust struct.
    Struct(Box<Struct<'a>>),
    /// Represents a Rust enum.
    Enum(Box<Enum<'a>>),
    /// Represents a Rust tuple.
    Tuple(Vec<Value<'a>>),
}

impl Value<'_> {
    /// Moves data where possible or otherwise clones it into an owned object.
    pub fn into_owned(self) -> Value<'static> {
        match self {
            Value::Unit => Value::Unit,
            Value::Bool(v) => Value::Bool(v),
            Value::Number(v) => Value::Number(v),
            Value::Char(v) => Value::Char(v),
            Value::String(v) => Value::String(Cow::Owned(v.into_owned())),
            Value::Bytes(v) => Value::Bytes(Cow::Owned(v.into_owned())),
            Value::Seq(v) => Value::Seq(v.into_iter().map(Self::into_owned).collect()),
            Value::Map(v) => Value::Map(
                v.into_iter()
                    .map(|(key, value)| (key.into_owned(), value.into_owned()))
                    .collect(),
            ),
            Value::Option(v) => match v {
                Some(v) => Value::Option(Some(Box::new(v.into_owned()))),
                None => Value::Option(None),
            },
            Value::Struct(v) => Value::Struct(Box::new(v.into_owned())),
            Value::Enum(v) => Value::Enum(Box::new(v.into_owned())),
            Value::Tuple(v) => Value::Tuple(v.into_iter().map(Self::into_owned).collect()),
        }
    }
}

impl From<()> for Value<'static> {
    fn from(_: ()) -> Self {
        Self::Unit
    }
}

impl From<bool> for Value<'static> {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl<T> From<T> for Value<'static>
where
    T: Into<Number>,
{
    fn from(value: T) -> Self {
        Self::Number(value.into())
    }
}

impl From<char> for Value<'static> {
    fn from(value: char) -> Self {
        Self::Char(value)
    }
}

impl<'a> From<Cow<'a, str>> for Value<'a> {
    fn from(value: Cow<'a, str>) -> Self {
        Self::String(value)
    }
}

impl<'a> From<&'a str> for Value<'a> {
    fn from(value: &'a str) -> Self {
        Self::String(Cow::Borrowed(value))
    }
}

impl<'a> From<&'a String> for Value<'a> {
    fn from(value: &'a String) -> Self {
        Self::String(Cow::Borrowed(value))
    }
}

impl From<String> for Value<'static> {
    fn from(value: String) -> Self {
        Self::String(Cow::Owned(value))
    }
}

impl<'a> From<&'a [u8]> for Value<'a> {
    fn from(value: &'a [u8]) -> Self {
        Self::Bytes(Cow::Borrowed(value))
    }
}

impl<'a> From<&'a Vec<u8>> for Value<'a> {
    fn from(value: &'a Vec<u8>) -> Self {
        Self::Bytes(Cow::Borrowed(value))
    }
}

impl From<Vec<u8>> for Value<'static> {
    fn from(value: Vec<u8>) -> Self {
        Self::Bytes(Cow::Owned(value))
    }
}
