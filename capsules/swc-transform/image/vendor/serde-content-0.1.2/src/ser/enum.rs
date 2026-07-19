use crate::ser::to_static_str;
use crate::ser::Value;
use crate::Data;
use crate::Error;
use crate::Serializer;
use alloc::borrow::Cow;
use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use serde::ser;
use serde::ser::SerializeMap;
use serde::ser::SerializeStructVariant;
use serde::ser::SerializeTupleVariant;

pub struct Enum<'a> {
    r#enum: crate::Enum<'a>,
    human_readable: bool,
}

impl<'a> Enum<'a> {
    pub(super) const fn new(r#enum: crate::Enum<'a>, human_readable: bool) -> Self {
        Self {
            r#enum,
            human_readable,
        }
    }
}

impl ser::Serialize for crate::Enum<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: ser::Serializer,
    {
        match &self.data {
            Data::Unit => match (&self.name, &self.variant) {
                (Cow::Borrowed(name), Cow::Borrowed(variant)) => {
                    serializer.serialize_unit_variant(name, self.variant_index, variant)
                }
                _ => serializer.serialize_str(self.variant.as_ref()),
            },
            Data::NewType { value } => match (&self.name, &self.variant) {
                (Cow::Borrowed(name), Cow::Borrowed(variant)) => {
                    serializer.serialize_newtype_variant(name, self.variant_index, variant, value)
                }
                _ => {
                    let mut map = serializer.serialize_map(Some(1))?;
                    map.serialize_entry(&self.variant, &value)?;
                    map.end()
                }
            },
            Data::Tuple { values } => match (&self.name, &self.variant) {
                (Cow::Borrowed(name), Cow::Borrowed(variant)) => {
                    let mut tup = serializer.serialize_tuple_variant(
                        name,
                        self.variant_index,
                        variant,
                        values.len(),
                    )?;
                    for value in values {
                        tup.serialize_field(value)?;
                    }
                    tup.end()
                }
                _ => {
                    let mut map = serializer.serialize_map(Some(1))?;
                    map.serialize_entry(&self.variant, &values)?;
                    map.end()
                }
            },
            Data::Struct { fields } => match (&self.name, &self.variant) {
                (Cow::Borrowed(name), Cow::Borrowed(variant)) => {
                    let mut map = serializer.serialize_struct_variant(
                        name,
                        self.variant_index,
                        variant,
                        fields.len(),
                    )?;
                    for (key, value) in fields {
                        let key = to_static_str(key)?;
                        map.serialize_field(key, value)?;
                    }
                    map.end()
                }
                _ => {
                    let mut btree = BTreeMap::new();
                    for (key, value) in fields {
                        btree.insert(key, value);
                    }
                    let mut map = serializer.serialize_map(Some(1))?;
                    map.serialize_entry(&self.variant, &btree)?;
                    map.end()
                }
            },
        }
    }
}

impl<'a> ser::SerializeStructVariant for Enum<'a> {
    type Ok = Value<'a>;
    type Error = Error;

    fn serialize_field<T>(&mut self, key: &'static str, value: &T) -> Result<(), Error>
    where
        T: ?Sized + ser::Serialize,
    {
        if let Data::Struct { fields } = &mut self.r#enum.data {
            let value = value.serialize(Serializer::with_human_readable(self.human_readable))?;
            fields.push((Cow::Borrowed(key), value));
        }
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Error> {
        Ok(Value::Enum(Box::new(self.r#enum)))
    }
}

impl<'a> ser::SerializeTupleVariant for Enum<'a> {
    type Ok = Value<'a>;
    type Error = Error;

    fn serialize_field<T>(&mut self, value: &T) -> Result<(), Error>
    where
        T: ?Sized + ser::Serialize,
    {
        if let Data::Tuple { values } = &mut self.r#enum.data {
            let value = value.serialize(Serializer::with_human_readable(self.human_readable))?;
            values.push(value);
        }
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Error> {
        Ok(Value::Enum(Box::new(self.r#enum)))
    }
}
