#![cfg(feature = "serde")]

mod r#enum;
mod identifier;
mod map;
mod number;
mod seq;
mod tests;

use crate::Data;
use crate::DataType;
use crate::Error;
use crate::Expected;
use crate::Number;
use crate::Value;
use alloc::borrow::Cow;
use alloc::borrow::ToOwned;
use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;
use identifier::Identifier;
use map::Map;
use seq::Seq;
use serde::de;
use serde::Deserialize;
mod error;
use map::Key;
use serde::de::MapAccess;
use serde::de::SeqAccess;
use serde::de::Visitor;

pub use error::Unexpected;

/// A structure that deserializes Rust values into [Value].
#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub struct Deserializer<'de> {
    value: Value<'de>,
    human_readable: bool,
    coerce_numbers: bool,
}

impl<'de> Deserializer<'de> {
    /// Creates a deserializer.
    ///
    /// The deserializer created doesn't deserialize in human-readable form. To deserialize
    /// in human-readable form, call [Deserializer::human_readable] on the resulting deserializer.
    pub const fn new(value: Value<'de>) -> Self {
        Self {
            value,
            human_readable: false,
            coerce_numbers: false,
        }
    }

    /// Make `Deserialize` implementations deserialize in human-readable form.
    pub const fn human_readable(mut self) -> Self {
        self.human_readable = true;
        self
    }

    /// When deseriazing numbers try to coerce different number types into the expected type.
    pub const fn coerce_numbers(mut self) -> Self {
        self.coerce_numbers = true;
        self
    }

    /// Deserializes a value `T` from [`Value`]
    pub fn deserialize<T>(self) -> Result<T, Error>
    where
        T: de::Deserialize<'de>,
    {
        T::deserialize(self)
    }
}

#[cfg(feature = "std")]
impl<'de> serde::de::IntoDeserializer<'de, Error> for Deserializer<'de> {
    type Deserializer = Deserializer<'de>;

    fn into_deserializer(self) -> Self::Deserializer {
        self
    }
}

#[cfg(feature = "std")]
impl<'de> serde::de::IntoDeserializer<'de, Error> for Value<'de> {
    type Deserializer = Deserializer<'de>;

    fn into_deserializer(self) -> Self::Deserializer {
        Deserializer::new(self)
    }
}

impl<'de> de::Deserializer<'de> for Deserializer<'de> {
    type Error = Error;

    fn deserialize_any<V>(mut self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Unit => visitor.visit_unit(),
            Value::Bool(v) => visitor.visit_bool(v),
            Value::Number(n) => match n {
                Number::I8(v) => visitor.visit_i8(v),
                Number::U8(v) => visitor.visit_u8(v),
                Number::I16(v) => visitor.visit_i16(v),
                Number::U16(v) => visitor.visit_u16(v),
                Number::I32(v) => visitor.visit_i32(v),
                Number::U32(v) => visitor.visit_u32(v),
                Number::F32(v) => visitor.visit_f32(v),
                Number::I64(v) => visitor.visit_i64(v),
                Number::U64(v) => visitor.visit_u64(v),
                Number::F64(v) => visitor.visit_f64(v),
                Number::I128(v) => visitor.visit_i128(v),
                Number::U128(v) => visitor.visit_u128(v),
            },
            Value::Char(v) => visitor.visit_char(v),
            Value::String(v) => match v {
                Cow::Borrowed(v) => visitor.visit_borrowed_str(v),
                Cow::Owned(v) => visitor.visit_string(v),
            },
            Value::Bytes(v) => match v {
                Cow::Borrowed(v) => visitor.visit_borrowed_bytes(v),
                Cow::Owned(v) => visitor.visit_byte_buf(v),
            },
            Value::Seq(v) => {
                visitor.visit_seq(Seq::new(v, self.human_readable, self.coerce_numbers))
            }
            Value::Map(v) => {
                visitor.visit_map(Map::from((v, self.human_readable, self.coerce_numbers)))
            }
            Value::Option(v) => match v {
                Some(v) => {
                    self.value = *v;
                    visitor.visit_some(self)
                }
                None => visitor.visit_none(),
            },
            Value::Struct(v) => match v.data {
                Data::Unit => visitor.visit_unit(),
                Data::NewType { value } => {
                    self.value = value;
                    visitor.visit_newtype_struct(self)
                }
                Data::Tuple { values } => {
                    let tuple = Seq::new(values, self.human_readable, self.coerce_numbers);
                    visitor.visit_seq(tuple)
                }
                Data::Struct { fields } => {
                    let len = fields.len();
                    let mut vec = Vec::with_capacity(len);
                    for (index, (key, value)) in fields.into_iter().enumerate() {
                        let key = Key::Identifier(Identifier::new(key, index as u64));
                        vec.push((key, value));
                    }
                    let data = Map::new(vec, self.human_readable, self.coerce_numbers);
                    visitor.visit_map(data)
                }
            },
            Value::Enum(v) => r#enum::visit_enum(
                v.name.clone(),
                v,
                self.human_readable,
                self.coerce_numbers,
                visitor,
            ),
            Value::Tuple(v) => {
                visitor.visit_seq(Seq::new(v, self.human_readable, self.coerce_numbers))
            }
        }
    }

    fn deserialize_bool<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Bool(v) => visitor.visit_bool(v),
            _ => Err(self.value.unexpected(Expected::Bool)),
        }
    }

    fn deserialize_i8<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::I8, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::I8)),
        }
    }

    fn deserialize_i16<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::I16, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::I16)),
        }
    }

    fn deserialize_i32<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::I32, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::I32)),
        }
    }

    fn deserialize_i64<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::I64, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::I64)),
        }
    }

    fn deserialize_i128<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::I128, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::I128)),
        }
    }

    fn deserialize_u8<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::U8, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::U8)),
        }
    }

    fn deserialize_u16<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::U16, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::U16)),
        }
    }

    fn deserialize_u32<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::U32, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::U32)),
        }
    }

    fn deserialize_u64<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::U64, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::U64)),
        }
    }

    fn deserialize_u128<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::U128, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::U128)),
        }
    }

    fn deserialize_f32<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::F32, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::F32)),
        }
    }

    fn deserialize_f64<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Number(n) => number::visit(n, Expected::F64, self.coerce_numbers, visitor),
            _ => Err(self.value.unexpected(Expected::F64)),
        }
    }

    fn deserialize_char<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Char(v) => visitor.visit_char(v),
            _ => Err(self.value.unexpected(Expected::Char)),
        }
    }

    fn deserialize_str<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::String(v) => match v {
                Cow::Borrowed(v) => visitor.visit_borrowed_str(v),
                Cow::Owned(v) => visitor.visit_string(v),
            },
            _ => Err(self.value.unexpected(Expected::String)),
        }
    }

    fn deserialize_string<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        self.deserialize_str(visitor)
    }

    fn deserialize_bytes<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Bytes(v) => match v {
                Cow::Borrowed(v) => visitor.visit_borrowed_bytes(v),
                Cow::Owned(v) => visitor.visit_byte_buf(v),
            },
            _ => Err(self.value.unexpected(Expected::Bytes)),
        }
    }

    fn deserialize_byte_buf<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        self.deserialize_bytes(visitor)
    }

    fn deserialize_option<V>(mut self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Option(v) => match v {
                Some(v) => {
                    self.value = *v;
                    visitor.visit_some(self)
                }
                None => visitor.visit_none(),
            },
            _ => visitor.visit_some(self),
        }
    }

    fn deserialize_unit<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Unit => visitor.visit_unit(),
            _ => Err(self.value.unexpected(Expected::Unit)),
        }
    }

    fn deserialize_unit_struct<V>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Struct(v) => match v.data {
                Data::Unit => visitor.visit_unit(),
                _ => Err(v.unexpected(Expected::Struct {
                    name: Some(name.to_owned()),
                    typ: Some(DataType::Unit),
                })),
            },
            Value::Unit => self.deserialize_unit(visitor),
            _ => Err(self.value.unexpected(Expected::Struct {
                name: Some(name.to_owned()),
                typ: Some(DataType::Unit),
            })),
        }
    }

    fn deserialize_newtype_struct<V>(
        mut self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Struct(v) => match v.data {
                Data::NewType { value } => {
                    self.value = value;
                    visitor.visit_newtype_struct(self)
                }
                _ => {
                    self.value = Value::Struct(v);
                    visitor.visit_newtype_struct(self)
                }
            },
            _ => visitor.visit_newtype_struct(self),
        }
    }

    fn deserialize_seq<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Seq(v) => {
                visitor.visit_seq(Seq::new(v, self.human_readable, self.coerce_numbers))
            }
            _ => Err(self.value.unexpected(Expected::Seq)),
        }
    }

    fn deserialize_tuple<V>(self, len: usize, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Tuple(v) => {
                visitor.visit_seq(Seq::new(v, self.human_readable, self.coerce_numbers))
            }
            Value::Seq(_) => self.deserialize_seq(visitor),
            _ => Err(self.value.unexpected(Expected::Tuple(len))),
        }
    }

    fn deserialize_tuple_struct<V>(
        self,
        name: &'static str,
        _len: usize,
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Struct(v) => match v.data {
                Data::Tuple { values } => {
                    visitor.visit_seq(Seq::new(values, self.human_readable, self.coerce_numbers))
                }
                _ => Err(v.unexpected(Expected::Struct {
                    name: Some(name.to_owned()),
                    typ: Some(DataType::Tuple),
                })),
            },
            Value::Seq(_) => self.deserialize_seq(visitor),
            _ => Err(self.value.unexpected(Expected::Struct {
                name: Some(name.to_owned()),
                typ: Some(DataType::Tuple),
            })),
        }
    }

    fn deserialize_map<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Map(v) => {
                visitor.visit_map(Map::from((v, self.human_readable, self.coerce_numbers)))
            }
            _ => Err(self.value.unexpected(Expected::Map)),
        }
    }

    fn deserialize_struct<V>(
        self,
        name: &'static str,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Struct(v) => match v.data {
                Data::Struct { fields } => visitor.visit_map(Map::from((
                    fields,
                    self.human_readable,
                    self.coerce_numbers,
                ))),
                _ => Err(v.unexpected(Expected::Struct {
                    name: Some(name.to_owned()),
                    typ: Some(DataType::Struct),
                })),
            },
            Value::Map(_) => self.deserialize_map(visitor),
            _ => Err(self.value.unexpected(Expected::Struct {
                name: Some(name.to_owned()),
                typ: Some(DataType::Struct),
            })),
        }
    }

    fn deserialize_enum<V>(
        self,
        name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::Enum(v) => r#enum::visit_enum(
                Cow::Borrowed(name),
                v,
                self.human_readable,
                self.coerce_numbers,
                visitor,
            ),
            Value::String(string) => visitor.visit_enum(r#enum::Access {
                expected: name,
                name: Value::String(string),
                data: None,
                human_readable: self.human_readable,
                coerce_numbers: self.coerce_numbers,
            }),
            Value::Map(mut map) if map.len() == 1 => {
                let (variant, data) = map.pop().unwrap();
                visitor.visit_enum(r#enum::Access {
                    expected: name,
                    name: variant,
                    data: Some(data),
                    human_readable: self.human_readable,
                    coerce_numbers: self.coerce_numbers,
                })
            }
            _ => Err(self.value.unexpected(Expected::Enum {
                name: Some(name.to_owned()),
                typ: None,
            })),
        }
    }

    fn deserialize_identifier<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.value {
            Value::String(v) => match v {
                Cow::Borrowed(v) => visitor.visit_borrowed_str(v),
                Cow::Owned(v) => visitor.visit_string(v),
            },
            Value::Enum(v) => match v.variant {
                Cow::Borrowed(v) => visitor.visit_borrowed_str(v),
                Cow::Owned(v) => visitor.visit_string(v),
            },
            _ => Err(self.value.unexpected(Expected::Identifier)),
        }
    }

    fn deserialize_ignored_any<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        visitor.visit_unit()
    }

    fn is_human_readable(&self) -> bool {
        self.human_readable
    }
}

impl<'de> de::Deserialize<'de> for Value<'static> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        let value: Value = deserializer.deserialize_any(ValueVisitor)?;
        Ok(value.into_owned())
    }
}

/// A Serde visitor that deserializes any value into [crate::Value].
///
/// ## Example
///
/// ```
/// # use serde::de::Deserializer as _;
/// # use serde_content::{Value, ValueVisitor, Deserializer};
/// # fn main() -> serde_content::Result<()> {
/// # let deserializer = Deserializer::new(Value::Unit);
/// let value = deserializer.deserialize_any(ValueVisitor)?;
/// # Ok(()) }
/// ```
pub struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Value<'de>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("any value")
    }

    fn visit_bool<F>(self, value: bool) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Bool(value))
    }

    fn visit_i8<F>(self, value: i8) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::I8(value)))
    }

    fn visit_i16<F>(self, value: i16) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::I16(value)))
    }

    fn visit_i32<F>(self, value: i32) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::I32(value)))
    }

    fn visit_i64<F>(self, value: i64) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::I64(value)))
    }

    fn visit_u8<F>(self, value: u8) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::U8(value)))
    }

    fn visit_u16<F>(self, value: u16) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::U16(value)))
    }

    fn visit_u32<F>(self, value: u32) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::U32(value)))
    }

    fn visit_u64<F>(self, value: u64) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::U64(value)))
    }

    fn visit_f32<F>(self, value: f32) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::F32(value)))
    }

    fn visit_f64<F>(self, value: f64) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Number(Number::F64(value)))
    }

    fn visit_char<F>(self, value: char) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Char(value))
    }

    fn visit_str<F>(self, value: &str) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::String(Cow::Owned(value.to_owned())))
    }

    fn visit_borrowed_str<F>(self, value: &'de str) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::String(Cow::Borrowed(value)))
    }

    fn visit_string<F>(self, value: String) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::String(Cow::Owned(value)))
    }

    fn visit_bytes<F>(self, value: &[u8]) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Bytes(Cow::Owned(value.to_owned())))
    }

    fn visit_borrowed_bytes<F>(self, value: &'de [u8]) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Bytes(Cow::Borrowed(value)))
    }

    fn visit_byte_buf<F>(self, value: Vec<u8>) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Bytes(Cow::Owned(value)))
    }

    fn visit_unit<F>(self) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Unit)
    }

    fn visit_none<F>(self) -> Result<Self::Value, F>
    where
        F: de::Error,
    {
        Ok(Value::Option(None))
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        de::Deserialize::deserialize(deserializer).map(|v| Value::Option(Some(Box::new(v))))
    }

    fn visit_newtype_struct<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        Deserialize::deserialize(deserializer)
    }

    fn visit_seq<V>(self, mut visitor: V) -> Result<Self::Value, V::Error>
    where
        V: SeqAccess<'de>,
    {
        let len = visitor.size_hint().unwrap_or_default();
        let mut vec = Vec::with_capacity(len);
        while let Some(e) = visitor.next_element()? {
            vec.push(e);
        }
        Ok(Value::Seq(vec))
    }

    fn visit_map<V>(self, mut visitor: V) -> Result<Self::Value, V::Error>
    where
        V: MapAccess<'de>,
    {
        let len = visitor.size_hint().unwrap_or_default();
        let mut vec = Vec::with_capacity(len);
        while let Some(kv) = visitor.next_entry()? {
            vec.push(kv);
        }
        Ok(Value::Map(vec))
    }

    fn visit_i128<E>(self, v: i128) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Number(Number::I128(v)))
    }

    fn visit_u128<E>(self, v: u128) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::Number(Number::U128(v)))
    }
}
