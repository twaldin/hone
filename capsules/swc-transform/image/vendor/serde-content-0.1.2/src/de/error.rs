use crate::{Data, Enum, Error, Expected, Found, FoundData, Number, Struct, Value};
use alloc::boxed::Box;
use alloc::vec::Vec;

/// A convenience wrapper for constructing [crate::Found] and returning an error.
pub trait Unexpected {
    /// Consumes the type and returns an error.
    fn unexpected(self, expected: Expected) -> Error;
}

impl Unexpected for Number {
    fn unexpected(self, expected: Expected) -> Error {
        let found = Found::Number(self);
        Error::unexpected(found, expected)
    }
}

impl Value<'_> {
    fn into_found(self) -> Found {
        match self {
            Value::Unit => Found::Unit,
            Value::Bool(v) => Found::Bool(v),
            Value::Number(v) => Found::Number(v),
            Value::Char(v) => Found::Char(v),
            Value::String(v) => Found::String(v.into_owned()),
            Value::Bytes(v) => Found::Bytes(v.into_owned()),
            Value::Seq(v) => {
                let mut vec = Vec::with_capacity(v.len());
                for value in v {
                    vec.push(value.into_found());
                }
                Found::Seq(vec)
            }
            Value::Map(v) => {
                let mut vec = Vec::with_capacity(v.len());
                for (key, value) in v {
                    vec.push((key.into_found(), value.into_found()));
                }
                Found::Map(vec)
            }
            Value::Option(v) => Found::Option(v.map(|x| Box::new(x.into_found()))),
            Value::Struct(v) => Found::Struct {
                name: v.name.into_owned(),
                data: Box::new(v.data.into_found()),
            },
            Value::Enum(v) => Found::Enum {
                name: v.name.into_owned(),
                variant: v.variant.into_owned(),
                data: Box::new(v.data.into_found()),
            },
            Value::Tuple(v) => {
                let mut vec = Vec::with_capacity(v.len());
                for value in v {
                    vec.push(value.into_found());
                }
                Found::Tuple(vec)
            }
        }
    }
}

impl Data<'_> {
    fn into_found(self) -> FoundData {
        match self {
            Data::Unit => FoundData::Unit,
            Data::NewType { value } => FoundData::NewType(value.into_found()),
            Data::Tuple { values } => {
                FoundData::Tuple(values.into_iter().map(Value::into_found).collect())
            }
            Data::Struct { fields } => FoundData::Struct(
                fields
                    .into_iter()
                    .map(|(k, v)| (k.into_owned(), v.into_found()))
                    .collect(),
            ),
        }
    }
}

impl Unexpected for Value<'_> {
    fn unexpected(self, expected: Expected) -> Error {
        let found = self.into_found();
        Error::unexpected(found, expected)
    }
}

impl Unexpected for Box<Struct<'_>> {
    fn unexpected(self, expected: Expected) -> Error {
        let found = Found::Struct {
            name: self.name.into_owned(),
            data: Box::new(self.data.into_found()),
        };
        Error::unexpected(found, expected)
    }
}

impl Unexpected for Box<Enum<'_>> {
    fn unexpected(self, expected: Expected) -> Error {
        let found = Found::Enum {
            name: self.name.into_owned(),
            variant: self.variant.into_owned(),
            data: Box::new(self.data.into_found()),
        };
        Error::unexpected(found, expected)
    }
}
