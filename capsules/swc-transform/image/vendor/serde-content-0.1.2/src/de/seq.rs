use crate::Deserializer;
use crate::Error;
use crate::Value;
use alloc::vec::IntoIter;
use alloc::vec::Vec;
use serde::de;

pub(super) struct Seq<'de> {
    iter: IntoIter<Value<'de>>,
    human_readable: bool,
    coerce_numbers: bool,
}

impl<'de> Seq<'de> {
    pub(super) fn new(vec: Vec<Value<'de>>, human_readable: bool, coerce_numbers: bool) -> Self {
        Self {
            human_readable,
            coerce_numbers,
            iter: vec.into_iter(),
        }
    }
}

impl<'de> de::SeqAccess<'de> for Seq<'de> {
    type Error = Error;

    fn next_element_seed<T>(&mut self, seed: T) -> Result<Option<T::Value>, Self::Error>
    where
        T: de::DeserializeSeed<'de>,
    {
        match self.iter.next() {
            Some(value) => {
                let deserializer = Deserializer {
                    value,
                    human_readable: self.human_readable,
                    coerce_numbers: self.coerce_numbers,
                };
                seed.deserialize(deserializer).map(Some)
            }
            None => Ok(None),
        }
    }

    fn size_hint(&self) -> Option<usize> {
        match self.iter.size_hint() {
            (lower, Some(upper)) if lower == upper => Some(upper),
            _ => None,
        }
    }
}
