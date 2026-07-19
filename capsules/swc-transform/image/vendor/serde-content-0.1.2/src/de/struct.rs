use crate::{Data, Struct};
use alloc::{borrow::Cow, vec::Vec};
use serde::{de, Deserialize};

#[cfg(feature = "std")]
impl<'de> serde::de::IntoDeserializer<'de, crate::Error> for Struct<'de> {
    type Deserializer = crate::Deserializer<'de>;

    fn into_deserializer(self) -> Self::Deserializer {
        use crate::Deserializer;
        use crate::Value;

        Deserializer::new(Value::Struct(Box::new(self)))
    }
}

impl<'de: 'a, 'a> Deserialize<'de> for Struct<'a> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_any(Visitor)
    }
}

pub(super) struct Visitor;

impl Visitor {
    pub(super) const fn new() -> Self {
        Self
    }
}

impl<'de> de::Visitor<'de> for Visitor {
    type Value = Struct<'de>;

    fn expecting(&self, formatter: &mut core::fmt::Formatter) -> core::fmt::Result {
        formatter.write_str("a struct")
    }

    fn visit_unit_struct<E>(self, name: &'static str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Struct {
            name: Cow::Borrowed(name),
            data: Data::Unit,
        })
    }

    fn visit_newtype_struct_with_name<D>(
        self,
        name: &'static str,
        deserializer: D,
    ) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        Ok(Struct {
            name: Cow::Borrowed(name),
            data: Data::NewType {
                value: Deserialize::deserialize(deserializer)?,
            },
        })
    }

    fn visit_tuple_struct<A>(
        self,
        name: &'static str,
        mut visitor: A,
    ) -> Result<Self::Value, A::Error>
    where
        A: de::SeqAccess<'de>,
    {
        let len = visitor.size_hint().unwrap_or_default();
        let mut values = Vec::with_capacity(len);
        while let Some(e) = visitor.next_element()? {
            values.push(e);
        }
        Ok(Struct {
            name: Cow::Borrowed(name),
            data: Data::Tuple { values },
        })
    }

    fn visit_struct<A>(
        self,
        name: &'static str,
        fields: &[&'static str],
        mut visitor: A,
    ) -> Result<Self::Value, A::Error>
    where
        A: de::MapAccess<'de>,
    {
        let len = fields.len();
        let len = visitor
            .size_hint()
            .filter(|x| *x != 0)
            .unwrap_or(len)
            .min(len);
        let mut vec = Vec::with_capacity(len);
        while let Some((key, value)) = visitor.next_entry()? {
            vec.push((key, value));
        }
        let data = Data::Struct { fields: vec };
        Ok(Struct {
            name: Cow::Borrowed(name),
            data,
        })
    }
}
