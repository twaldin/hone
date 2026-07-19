use crate::ser::Value;
use crate::Data;
use crate::Error;
use crate::Serializer;
use alloc::borrow::Cow;
use alloc::boxed::Box;
use serde::ser;
use serde::ser::SerializeMap;
use serde::ser::SerializeStruct;
use serde::ser::SerializeTupleStruct;

use super::to_static_str;

pub struct Struct<'a> {
    r#struct: crate::Struct<'a>,
    human_readable: bool,
}

impl<'a> Struct<'a> {
    pub(super) const fn new(r#struct: crate::Struct<'a>, human_readable: bool) -> Self {
        Self {
            r#struct,
            human_readable,
        }
    }
}

impl ser::Serialize for crate::Struct<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: ser::Serializer,
    {
        match &self.data {
            Data::Unit => match &self.name {
                Cow::Borrowed(name) => serializer.serialize_unit_struct(name),
                Cow::Owned(_) => serializer.serialize_unit(),
            },
            Data::NewType { value } => match &self.name {
                Cow::Borrowed(name) => serializer.serialize_newtype_struct(name, value),
                Cow::Owned(_) => value.serialize(serializer),
            },
            Data::Tuple { values } => match &self.name {
                Cow::Borrowed(name) => {
                    let mut tup = serializer.serialize_tuple_struct(name, values.len())?;
                    for value in values {
                        tup.serialize_field(value)?;
                    }
                    tup.end()
                }
                Cow::Owned(_) => values.serialize(serializer),
            },
            Data::Struct { fields } => match &self.name {
                Cow::Borrowed(name) => {
                    let mut map = serializer.serialize_struct(name, fields.len())?;
                    for (key, value) in fields {
                        let key = to_static_str(key)?;
                        map.serialize_field(key, value)?;
                    }
                    map.end()
                }
                Cow::Owned(_) => {
                    let mut map = serializer.serialize_map(Some(fields.len()))?;
                    for (key, value) in fields {
                        map.serialize_entry(key, value)?;
                    }
                    map.end()
                }
            },
        }
    }
}

impl<'a> ser::SerializeStruct for Struct<'a> {
    type Ok = Value<'a>;
    type Error = Error;

    fn serialize_field<T>(&mut self, key: &'static str, value: &T) -> Result<(), Error>
    where
        T: ?Sized + ser::Serialize,
    {
        if let Data::Struct { fields } = &mut self.r#struct.data {
            let value = value.serialize(Serializer::with_human_readable(self.human_readable))?;
            fields.push((Cow::Borrowed(key), value));
        }
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Error> {
        Ok(Value::Struct(Box::new(self.r#struct)))
    }
}

impl<'a> ser::SerializeTupleStruct for Struct<'a> {
    type Ok = Value<'a>;
    type Error = Error;

    fn serialize_field<T>(&mut self, value: &T) -> Result<(), Error>
    where
        T: ?Sized + ser::Serialize,
    {
        if let Data::Tuple { values } = &mut self.r#struct.data {
            let value = value.serialize(Serializer::with_human_readable(self.human_readable))?;
            values.push(value);
        }
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Error> {
        Ok(Value::Struct(Box::new(self.r#struct)))
    }
}
