use crate::de::error::Unexpected;
use crate::de::identifier::Identifier;
use crate::de::Map;
use crate::de::Seq;
use crate::Data;
use crate::DataType;
use crate::Enum;
use crate::Error;
use crate::Expected;
use crate::Value;
use alloc::borrow::Cow;
use alloc::borrow::ToOwned;
use alloc::boxed::Box;
use serde::de;
use serde::Deserializer as _;

#[cfg(feature = "std")]
impl<'de> serde::de::IntoDeserializer<'de, Error> for Enum<'de> {
    type Deserializer = crate::Deserializer<'de>;

    fn into_deserializer(self) -> Self::Deserializer {
        use crate::Deserializer;

        Deserializer::new(Value::Enum(Box::new(self)))
    }
}

pub(super) struct Deserializer<'de> {
    // The name of the enum we are expecting
    expected: Cow<'static, str>,
    enum_box: Box<Enum<'de>>,
    human_readable: bool,
    coerce_numbers: bool,
}

impl<'de> de::EnumAccess<'de> for Deserializer<'de> {
    type Error = Error;
    type Variant = Self;

    fn variant_seed<V>(self, seed: V) -> Result<(V::Value, Self::Variant), Error>
    where
        V: de::DeserializeSeed<'de>,
    {
        let variant = Identifier::new(
            self.enum_box.variant.clone(),
            self.enum_box.variant_index as u64,
        );
        seed.deserialize(variant).map(|v| (v, self))
    }
}

impl<'de> de::VariantAccess<'de> for Deserializer<'de> {
    type Error = Error;

    fn unit_variant(self) -> Result<(), Self::Error> {
        match self.enum_box.data {
            Data::Unit => Ok(()),
            _ => Err(self.enum_box.unexpected(Expected::Enum {
                name: Some(self.expected.into_owned()),
                typ: Some(DataType::Unit),
            })),
        }
    }

    fn newtype_variant_seed<T>(self, seed: T) -> Result<T::Value, Self::Error>
    where
        T: de::DeserializeSeed<'de>,
    {
        match self.enum_box.data {
            Data::NewType { value } => {
                let deserializer = crate::Deserializer {
                    value,
                    human_readable: self.human_readable,
                    coerce_numbers: self.coerce_numbers,
                };
                seed.deserialize(deserializer)
            }
            _ => Err(self.enum_box.unexpected(Expected::Enum {
                name: Some(self.expected.into_owned()),
                typ: Some(DataType::NewType),
            })),
        }
    }

    fn tuple_variant<V>(self, _len: usize, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        match self.enum_box.data {
            Data::Tuple { values } => {
                visitor.visit_seq(Seq::new(values, self.human_readable, self.coerce_numbers))
            }
            _ => Err(self.enum_box.unexpected(Expected::Enum {
                name: Some(self.expected.into_owned()),
                typ: Some(DataType::Tuple),
            })),
        }
    }

    fn struct_variant<V>(
        self,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        match self.enum_box.data {
            Data::Struct { fields } => visitor.visit_map(Map::from((
                fields,
                self.human_readable,
                self.coerce_numbers,
            ))),
            _ => Err(self.enum_box.unexpected(Expected::Enum {
                name: Some(self.expected.into_owned()),
                typ: Some(DataType::Struct),
            })),
        }
    }
}

pub(super) fn visit_enum<'de, V>(
    expected: Cow<'static, str>,
    enum_box: Box<Enum<'de>>,
    human_readable: bool,
    coerce_numbers: bool,
    visitor: V,
) -> Result<V::Value, Error>
where
    V: de::Visitor<'de>,
{
    let deserializer = Deserializer {
        expected,
        enum_box,
        human_readable,
        coerce_numbers,
    };
    visitor.visit_enum(deserializer)
}

pub(super) struct Access<'de> {
    // The name of the enum we are expecting
    pub(super) expected: &'static str,
    pub(super) name: Value<'de>,
    pub(super) data: Option<Value<'de>>,
    pub(super) human_readable: bool,
    pub(super) coerce_numbers: bool,
}

impl<'de> de::EnumAccess<'de> for Access<'de> {
    type Error = Error;
    type Variant = VariantAccess<'de>;

    fn variant_seed<V>(self, seed: V) -> Result<(V::Value, Self::Variant), Self::Error>
    where
        V: de::DeserializeSeed<'de>,
    {
        let deserializer = crate::Deserializer {
            value: self.name,
            human_readable: self.human_readable,
            coerce_numbers: self.coerce_numbers,
        };
        seed.deserialize(deserializer).map(|v| {
            (
                v,
                VariantAccess {
                    expected: self.expected,
                    data: self.data,
                    human_readable: self.human_readable,
                    coerce_numbers: self.coerce_numbers,
                },
            )
        })
    }
}

pub(super) struct VariantAccess<'de> {
    // The name of the enum we are expecting
    expected: &'static str,
    data: Option<Value<'de>>,
    human_readable: bool,
    coerce_numbers: bool,
}

impl<'de> de::VariantAccess<'de> for VariantAccess<'de> {
    type Error = Error;

    fn unit_variant(self) -> Result<(), Self::Error> {
        match self.data {
            None => Ok(()),
            Some(v) => Err(v.unexpected(Expected::Enum {
                name: Some(self.expected.to_owned()),
                typ: Some(DataType::Unit),
            })),
        }
    }

    fn newtype_variant_seed<T>(self, seed: T) -> Result<T::Value, Self::Error>
    where
        T: de::DeserializeSeed<'de>,
    {
        match self.data {
            Some(value) => {
                let deserializer = crate::Deserializer {
                    value,
                    human_readable: self.human_readable,
                    coerce_numbers: self.coerce_numbers,
                };
                seed.deserialize(deserializer)
            }
            None => Err(Value::Unit.unexpected(Expected::Enum {
                name: Some(self.expected.to_owned()),
                typ: Some(DataType::NewType),
            })),
        }
    }

    fn tuple_variant<V>(self, _len: usize, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        match self.data {
            Some(Value::Seq(seq)) => {
                let deserializer = crate::Deserializer {
                    value: Value::Seq(seq),
                    human_readable: self.human_readable,
                    coerce_numbers: self.coerce_numbers,
                };
                deserializer.deserialize_seq(visitor)
            }
            Some(v) => Err(v.unexpected(Expected::Enum {
                name: Some(self.expected.to_owned()),
                typ: Some(DataType::Tuple),
            })),
            None => Err(Value::Unit.unexpected(Expected::Enum {
                name: Some(self.expected.to_owned()),
                typ: Some(DataType::NewType),
            })),
        }
    }

    fn struct_variant<V>(
        self,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        match self.data {
            Some(Value::Map(map)) => {
                let deserializer = crate::Deserializer {
                    value: Value::Map(map),
                    human_readable: self.human_readable,
                    coerce_numbers: self.coerce_numbers,
                };
                deserializer.deserialize_map(visitor)
            }
            Some(v) => Err(v.unexpected(Expected::Enum {
                name: Some(self.expected.to_owned()),
                typ: Some(DataType::Struct),
            })),
            None => Err(Value::Unit.unexpected(Expected::Enum {
                name: Some(self.expected.to_owned()),
                typ: Some(DataType::NewType),
            })),
        }
    }
}
