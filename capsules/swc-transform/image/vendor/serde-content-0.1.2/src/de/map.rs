use crate::de::identifier::Identifier;
use crate::Deserializer;
use crate::Error;
use crate::Value;
use alloc::borrow::Cow;
use alloc::vec::IntoIter;
use alloc::vec::Vec;
use core::iter::Peekable;
use core::mem;
use serde::de;

pub(super) enum Key<'de> {
    Identifier(Identifier),
    Value(Value<'de>),
}

pub(super) struct Map<'de> {
    iter: Peekable<IntoIter<(Key<'de>, Value<'de>)>>,
    human_readable: bool,
    coerce_numbers: bool,
}

impl<'de> Map<'de> {
    pub(super) fn new(
        vec: Vec<(Key<'de>, Value<'de>)>,
        human_readable: bool,
        coerce_numbers: bool,
    ) -> Self {
        Self {
            human_readable,
            coerce_numbers,
            iter: vec.into_iter().peekable(),
        }
    }
}

impl<'de> de::MapAccess<'de> for Map<'de> {
    type Error = Error;

    fn next_key_seed<T>(&mut self, seed: T) -> Result<Option<T::Value>, Error>
    where
        T: de::DeserializeSeed<'de>,
    {
        match self.iter.peek_mut() {
            Some((key, _)) => match mem::replace(key, Key::Value(Value::Unit)) {
                Key::Value(value) => {
                    let deserializer = Deserializer {
                        value,
                        human_readable: self.human_readable,
                        coerce_numbers: self.coerce_numbers,
                    };
                    seed.deserialize(deserializer).map(Some)
                }
                Key::Identifier(identifier) => seed.deserialize(identifier).map(Some),
            },
            None => Ok(None),
        }
    }

    fn next_value_seed<T>(&mut self, seed: T) -> Result<T::Value, Error>
    where
        T: de::DeserializeSeed<'de>,
    {
        match self.iter.next() {
            Some((_, value)) => {
                let deserializer = Deserializer {
                    value,
                    human_readable: self.human_readable,
                    coerce_numbers: self.coerce_numbers,
                };
                seed.deserialize(deserializer)
            }
            None => Err(de::Error::custom("[BUG] value is missing")),
        }
    }

    fn next_entry_seed<K, V>(
        &mut self,
        kseed: K,
        vseed: V,
    ) -> Result<Option<(K::Value, V::Value)>, Self::Error>
    where
        K: de::DeserializeSeed<'de>,
        V: de::DeserializeSeed<'de>,
    {
        match self.iter.next() {
            Some((key, value)) => {
                let key = match key {
                    Key::Identifier(identifier) => kseed.deserialize(identifier)?,
                    Key::Value(value) => {
                        let deserializer = Deserializer {
                            value,
                            human_readable: self.human_readable,
                            coerce_numbers: self.coerce_numbers,
                        };
                        kseed.deserialize(deserializer)?
                    }
                };
                let deserializer = Deserializer {
                    value,
                    human_readable: self.human_readable,
                    coerce_numbers: self.coerce_numbers,
                };
                let value = vseed.deserialize(deserializer)?;
                Ok(Some((key, value)))
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

impl<'de> From<(Vec<(Cow<'static, str>, Value<'de>)>, bool, bool)> for Map<'de> {
    fn from(fields: (Vec<(Cow<'static, str>, Value<'de>)>, bool, bool)) -> Self {
        let mut vec = Vec::with_capacity(fields.0.len());
        for (index, (key, value)) in fields.0.into_iter().enumerate() {
            let key = Key::Identifier(Identifier::new(key, index as u64));
            vec.push((key, value));
        }
        Self::new(vec, fields.1, fields.2)
    }
}

impl<'de> From<(Vec<(Value<'de>, Value<'de>)>, bool, bool)> for Map<'de> {
    fn from(fields: (Vec<(Value<'de>, Value<'de>)>, bool, bool)) -> Self {
        let mut vec = Vec::with_capacity(fields.0.len());
        for (key, value) in fields.0 {
            let key = Key::Value(key);
            vec.push((key, value));
        }
        Self::new(vec, fields.1, fields.2)
    }
}
