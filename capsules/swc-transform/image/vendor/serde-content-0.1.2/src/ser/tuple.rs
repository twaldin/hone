use crate::ser::Value;
use crate::Error;
use crate::Serializer;
use alloc::vec::Vec;
use serde::ser;

pub struct Tuple<'a> {
    vec: Vec<Value<'a>>,
    human_readable: bool,
}

impl<'a> Tuple<'a> {
    pub(super) const fn new(vec: Vec<Value<'a>>, human_readable: bool) -> Self {
        Self {
            vec,
            human_readable,
        }
    }
}

impl<'a> ser::SerializeTuple for Tuple<'a> {
    type Ok = Value<'a>;
    type Error = Error;

    fn serialize_element<T>(&mut self, value: &T) -> Result<(), Error>
    where
        T: ?Sized + ser::Serialize,
    {
        let value = value.serialize(Serializer::with_human_readable(self.human_readable))?;
        self.vec.push(value);
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Error> {
        Ok(Value::Tuple(self.vec))
    }
}
