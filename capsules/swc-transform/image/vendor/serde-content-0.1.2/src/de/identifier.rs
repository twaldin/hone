use crate::de::error::Unexpected;
use crate::DataType;
use crate::Error;
use crate::Expected;
use crate::Found;
use alloc::borrow::Cow;
use alloc::borrow::ToOwned;
use alloc::string::ToString;
use serde::de::Deserializer;
use serde::de::Visitor;

pub(super) struct Identifier {
    name: Cow<'static, str>,
    index: u64,
}

impl Unexpected for Identifier {
    fn unexpected(self, expected: Expected) -> Error {
        let found = Found::Identifier(self.name.to_string());
        Error::unexpected(found, expected)
    }
}

impl Identifier {
    pub(super) const fn new(name: Cow<'static, str>, index: u64) -> Self {
        Self { name, index }
    }
}

impl<'de> Deserializer<'de> for Identifier {
    type Error = Error;

    fn deserialize_any<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        self.deserialize_str(visitor)
    }

    fn deserialize_u64<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        visitor.visit_u64(self.index)
    }

    fn deserialize_str<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        match self.name {
            Cow::Borrowed(name) => visitor.visit_borrowed_str(name),
            Cow::Owned(name) => visitor.visit_string(name),
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
        match self.name {
            Cow::Borrowed(name) => visitor.visit_borrowed_bytes(name.as_bytes()),
            Cow::Owned(name) => visitor.visit_bytes(name.as_bytes()),
        }
    }

    fn deserialize_byte_buf<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        self.deserialize_bytes(visitor)
    }

    fn deserialize_option<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        visitor.visit_some(self)
    }

    fn deserialize_unit<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        visitor.visit_unit()
    }

    fn deserialize_identifier<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        self.deserialize_str(visitor)
    }

    fn deserialize_ignored_any<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        visitor.visit_unit()
    }

    fn deserialize_bool<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Bool))
    }

    fn deserialize_i8<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::I8))
    }

    fn deserialize_i16<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::I16))
    }

    fn deserialize_i32<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::I32))
    }

    fn deserialize_i64<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::I64))
    }

    fn deserialize_u8<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::U8))
    }

    fn deserialize_u16<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::U16))
    }

    fn deserialize_u32<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::U32))
    }

    fn deserialize_f32<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::F32))
    }

    fn deserialize_f64<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::F64))
    }

    fn deserialize_char<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Char))
    }

    fn deserialize_unit_struct<V>(
        self,
        name: &'static str,
        _visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Struct {
            name: Some(name.to_owned()),
            typ: Some(DataType::Unit),
        }))
    }

    fn deserialize_newtype_struct<V>(
        self,
        name: &'static str,
        _visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Struct {
            name: Some(name.to_owned()),
            typ: Some(DataType::NewType),
        }))
    }

    fn deserialize_seq<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Seq))
    }

    fn deserialize_tuple<V>(self, len: usize, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Tuple(len)))
    }

    fn deserialize_tuple_struct<V>(
        self,
        name: &'static str,
        _len: usize,
        _visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Struct {
            name: Some(name.to_owned()),
            typ: Some(DataType::Tuple),
        }))
    }

    fn deserialize_map<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Map))
    }

    fn deserialize_struct<V>(
        self,
        name: &'static str,
        _fields: &'static [&'static str],
        _visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Struct {
            name: Some(name.to_owned()),
            typ: Some(DataType::Struct),
        }))
    }

    fn deserialize_enum<V>(
        self,
        name: &'static str,
        _variants: &'static [&'static str],
        _visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: Visitor<'de>,
    {
        Err(self.unexpected(Expected::Enum {
            name: Some(name.to_owned()),
            typ: None,
        }))
    }
}
