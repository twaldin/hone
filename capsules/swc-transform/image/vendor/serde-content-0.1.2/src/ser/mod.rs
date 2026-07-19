#![cfg(feature = "serde")]

mod r#enum;
mod map;
mod number;
mod seq;
mod r#struct;
mod tests;
mod tuple;

use crate::Data;
use crate::Error;
use crate::Expected;
use crate::Found;
use crate::Number;
use crate::Value;
use alloc::borrow::Cow;
use alloc::borrow::ToOwned;
use alloc::boxed::Box;
use alloc::string::ToString;
use alloc::vec::Vec;
use core::fmt;
use core::marker::PhantomData;
use map::Map;
use r#enum::Enum;
use r#struct::Struct;
use seq::Seq;
use serde::ser;
use serde::ser::SerializeMap;
use serde::ser::SerializeSeq;
use serde::ser::SerializeTuple;
use tuple::Tuple;

/// A structure for serialising Rust values into [crate::Value].
#[derive(Debug, Clone, Copy, Default, PartialEq, PartialOrd)]
pub struct Serializer<'a> {
    human_readable: bool,
    lifetime: PhantomData<&'a ()>,
}

impl<'a> Serializer<'a> {
    /// Creates a serializer.
    ///
    /// The serializer created doesn't serialize in human-readable form. To serialize
    /// in human-readable form, call [Serializer::human_readable] on the resulting serializer.
    pub const fn new() -> Self {
        Self {
            human_readable: false,
            lifetime: PhantomData,
        }
    }

    /// Make `Serialize` implementations serialize in human-readable form.
    pub const fn human_readable(mut self) -> Self {
        self.human_readable = true;
        self
    }

    /// Convert a `T` into `Value` which is an enum that can represent any valid Rust data.
    pub fn serialize<T>(self, value: T) -> Result<Value<'a>, Error>
    where
        T: ser::Serialize,
    {
        value.serialize(self)
    }

    const fn with_human_readable(human_readable: bool) -> Self {
        Self {
            human_readable,
            lifetime: PhantomData,
        }
    }
}

impl<'a> ser::Serializer for Serializer<'a> {
    type Ok = Value<'a>;
    type Error = Error;

    type SerializeSeq = Seq<'a>;
    type SerializeTuple = Tuple<'a>;
    type SerializeTupleStruct = Struct<'a>;
    type SerializeTupleVariant = Enum<'a>;
    type SerializeMap = Map<'a>;
    type SerializeStruct = Struct<'a>;
    type SerializeStructVariant = Enum<'a>;

    fn serialize_bool(self, value: bool) -> Result<Self::Ok, Error> {
        Ok(Value::Bool(value))
    }

    fn serialize_i8(self, value: i8) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::I8(value)))
    }

    fn serialize_i16(self, value: i16) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::I16(value)))
    }

    fn serialize_i32(self, value: i32) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::I32(value)))
    }

    fn serialize_i64(self, value: i64) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::I64(value)))
    }

    fn serialize_i128(self, value: i128) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::I128(value)))
    }

    fn serialize_u8(self, value: u8) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::U8(value)))
    }

    fn serialize_u16(self, value: u16) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::U16(value)))
    }

    fn serialize_u32(self, value: u32) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::U32(value)))
    }

    fn serialize_u64(self, value: u64) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::U64(value)))
    }

    fn serialize_u128(self, value: u128) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::U128(value)))
    }

    fn serialize_f32(self, value: f32) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::F32(value)))
    }

    fn serialize_f64(self, value: f64) -> Result<Self::Ok, Error> {
        Ok(Value::Number(Number::F64(value)))
    }

    fn serialize_char(self, value: char) -> Result<Self::Ok, Error> {
        Ok(Value::Char(value))
    }

    fn serialize_str(self, value: &str) -> Result<Self::Ok, Error> {
        Ok(Value::String(Cow::Owned(value.to_owned())))
    }

    fn serialize_bytes(self, value: &[u8]) -> Result<Self::Ok, Error> {
        Ok(Value::Bytes(Cow::Owned(value.to_owned())))
    }

    fn serialize_unit(self) -> Result<Self::Ok, Error> {
        Ok(Value::Unit)
    }

    fn serialize_unit_struct(self, name: &'static str) -> Result<Self::Ok, Error> {
        Ok(Value::Struct(Box::new(super::Struct {
            name: Cow::Borrowed(name),
            data: Data::Unit,
        })))
    }

    fn serialize_unit_variant(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
    ) -> Result<Self::Ok, Error> {
        Ok(Value::Enum(Box::new(super::Enum {
            name: Cow::Borrowed(name),
            variant_index,
            variant: Cow::Borrowed(variant),
            data: Data::Unit,
        })))
    }

    fn serialize_newtype_struct<T>(self, name: &'static str, value: &T) -> Result<Self::Ok, Error>
    where
        T: ?Sized + ser::Serialize,
    {
        Ok(Value::Struct(Box::new(super::Struct {
            name: Cow::Borrowed(name),
            data: Data::NewType {
                value: value.serialize(self)?,
            },
        })))
    }

    fn serialize_newtype_variant<T>(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Error>
    where
        T: ?Sized + ser::Serialize,
    {
        Ok(Value::Enum(Box::new(super::Enum {
            name: Cow::Borrowed(name),
            variant_index,
            variant: Cow::Borrowed(variant),
            data: Data::NewType {
                value: value.serialize(self)?,
            },
        })))
    }

    fn serialize_none(self) -> Result<Self::Ok, Error> {
        Ok(Value::Option(None))
    }

    fn serialize_some<T>(self, value: &T) -> Result<Self::Ok, Error>
    where
        T: ?Sized + ser::Serialize,
    {
        let value = value.serialize(self)?;
        Ok(Value::Option(Some(Box::new(value))))
    }

    fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq, Error> {
        Ok(Seq::new(
            Vec::with_capacity(len.unwrap_or_default()),
            self.human_readable,
        ))
    }

    fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple, Error> {
        Ok(Tuple::new(Vec::with_capacity(len), self.human_readable))
    }

    fn serialize_tuple_struct(
        self,
        name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleStruct, Error> {
        let st = super::Struct {
            name: Cow::Borrowed(name),
            data: Data::Tuple {
                values: Vec::with_capacity(len),
            },
        };
        Ok(Struct::new(st, self.human_readable))
    }

    fn serialize_tuple_variant(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleVariant, Error> {
        let en = super::Enum {
            name: Cow::Borrowed(name),
            variant_index,
            variant: Cow::Borrowed(variant),
            data: Data::Tuple {
                values: Vec::with_capacity(len),
            },
        };
        Ok(Enum::new(en, self.human_readable))
    }

    fn serialize_map(self, len: Option<usize>) -> Result<Self::SerializeMap, Error> {
        Ok(Map::new(
            Vec::with_capacity(len.unwrap_or_default()),
            self.human_readable,
        ))
    }

    fn serialize_struct(
        self,
        name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeStruct, Error> {
        let st = super::Struct {
            name: Cow::Borrowed(name),
            data: Data::Struct {
                fields: Vec::with_capacity(len),
            },
        };
        Ok(Struct::new(st, self.human_readable))
    }

    fn serialize_struct_variant(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Self::SerializeStructVariant, Error> {
        let en = super::Enum {
            name: Cow::Borrowed(name),
            variant_index,
            variant: Cow::Borrowed(variant),
            data: Data::Struct {
                fields: Vec::with_capacity(len),
            },
        };
        Ok(Enum::new(en, self.human_readable))
    }

    fn collect_str<T>(self, value: &T) -> Result<Self::Ok, Self::Error>
    where
        T: ?Sized + fmt::Display,
    {
        Ok(Value::String(Cow::Owned(value.to_string())))
    }

    fn is_human_readable(&self) -> bool {
        self.human_readable
    }
}

impl ser::Serialize for Value<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: ser::Serializer,
    {
        match self {
            Value::Unit => serializer.serialize_unit(),
            Value::Bool(v) => serializer.serialize_bool(*v),
            Value::Number(v) => v.serialize(serializer),
            Value::Char(v) => serializer.serialize_char(*v),
            Value::String(v) => serializer.serialize_str(v.as_ref()),
            Value::Bytes(v) => serializer.serialize_bytes(v.as_ref()),
            Value::Seq(v) => {
                let mut seq = serializer.serialize_seq(Some(v.len()))?;
                for value in v {
                    seq.serialize_element(value)?;
                }
                seq.end()
            }
            Value::Map(v) => {
                let mut map = serializer.serialize_map(Some(v.len()))?;
                for (key, value) in v {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
            Value::Option(v) => match v {
                Some(v) => serializer.serialize_some(v),
                None => serializer.serialize_none(),
            },
            Value::Struct(v) => v.serialize(serializer),
            Value::Enum(v) => v.serialize(serializer),
            Value::Tuple(v) => {
                let mut tup = serializer.serialize_tuple(v.len())?;
                for value in v {
                    tup.serialize_element(value)?;
                }
                tup.end()
            }
        }
    }
}

#[allow(clippy::ptr_arg)]
fn to_static_str<E>(cow: &Cow<'static, str>) -> Result<&'static str, E>
where
    E: ser::Error,
{
    match cow {
        Cow::Borrowed(v) => Ok(*v),
        Cow::Owned(v) => {
            let found = Found::String(v.clone());
            let expected = Expected::StaticStr;
            let error = Error::unexpected(found, expected);
            Err(ser::Error::custom(error))
        }
    }
}
