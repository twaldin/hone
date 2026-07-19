use crate::Error;
use crate::Expected;
use crate::Number;
use crate::Unexpected;
use serde::de;
use serde::Deserialize;

#[cfg(feature = "std")]
impl<'de> serde::de::IntoDeserializer<'de, Error> for Number {
    type Deserializer = crate::Deserializer<'de>;

    fn into_deserializer(self) -> Self::Deserializer {
        use crate::Deserializer;
        use crate::Value;

        Deserializer::new(Value::Number(self))
    }
}

impl<'de> Deserialize<'de> for Number {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(Visitor)
    }
}

struct Visitor;

impl de::Visitor<'_> for Visitor {
    type Value = Number;

    fn expecting(&self, formatter: &mut core::fmt::Formatter) -> core::fmt::Result {
        formatter.write_str("a number")
    }

    fn visit_i8<E>(self, v: i8) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::I8(v))
    }

    fn visit_i16<E>(self, v: i16) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::I16(v))
    }

    fn visit_i32<E>(self, v: i32) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::I32(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::I64(v))
    }

    fn visit_i128<E>(self, v: i128) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::I128(v))
    }

    fn visit_u8<E>(self, v: u8) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::U8(v))
    }

    fn visit_u16<E>(self, v: u16) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::U16(v))
    }

    fn visit_u32<E>(self, v: u32) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::U32(v))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::U64(v))
    }

    fn visit_u128<E>(self, v: u128) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::U128(v))
    }

    fn visit_f32<E>(self, v: f32) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::F32(v))
    }

    fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Number::F64(v))
    }
}

macro_rules! range {
    ($min:ident, $max:ident as $dest:ty) => {
        (($min::MIN as $dest)..=($max::MAX as $dest))
    };
    ($src:ident as $dest:ty) => {
        (($src::MIN as $dest)..=($src::MAX as $dest))
    };
}

macro_rules! coerce_int {
    ($number:ident, $v:ident, $expected:ident, $visitor:ident) => {{
        match $expected {
            Expected::I8 => {
                $visitor.visit_i8($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            Expected::U8 => {
                $visitor.visit_u8($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            Expected::I16 => {
                $visitor.visit_i16($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            Expected::U16 => {
                $visitor.visit_u16($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            Expected::I32 => {
                $visitor.visit_i32($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            Expected::F32
                if i32::try_from($v).is_ok()
                    && range!(i16, u16 as i32).contains(&i32::try_from($v).unwrap()) =>
            {
                $visitor.visit_f32($v as f32)
            }
            Expected::U32 => {
                $visitor.visit_u32($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            Expected::I64 => {
                $visitor.visit_i64($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            Expected::F64
                if i64::try_from($v).is_ok()
                    && range!(i32, u32 as i64).contains(&i64::try_from($v).unwrap()) =>
            {
                $visitor.visit_f64($v as f64)
            }
            Expected::U64 => {
                $visitor.visit_u64($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            Expected::I128 => {
                $visitor.visit_i128($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            Expected::U128 => {
                $visitor.visit_u128($v.try_into().map_err(|_| $number.unexpected($expected))?)
            }
            _ => Err($number.unexpected($expected)),
        }
    }};
}

enum NumberType {
    Int,
    F32,
    F64,
}

impl Expected {
    const fn number_type(&self) -> NumberType {
        match self {
            Expected::F32 => NumberType::F32,
            Expected::F64 => NumberType::F64,
            _ => NumberType::Int,
        }
    }
}

pub(super) fn visit<'de, V>(
    number: Number,
    expected: Expected,
    coerce_numbers: bool,
    visitor: V,
) -> Result<V::Value, Error>
where
    V: de::Visitor<'de>,
{
    match (number, expected) {
        (Number::I8(v), Expected::I8) => visitor.visit_i8(v),
        (Number::U8(v), Expected::U8) => visitor.visit_u8(v),
        (Number::I16(v), Expected::I16) => visitor.visit_i16(v),
        (Number::U16(v), Expected::U16) => visitor.visit_u16(v),
        (Number::I32(v), Expected::I32) => visitor.visit_i32(v),
        (Number::U32(v), Expected::U32) => visitor.visit_u32(v),
        (Number::F32(v), Expected::F32) => visitor.visit_f32(v),
        (Number::I64(v), Expected::I64) => visitor.visit_i64(v),
        (Number::U64(v), Expected::U64) => visitor.visit_u64(v),
        (Number::F64(v), Expected::F64) => visitor.visit_f64(v),
        (Number::I128(v), Expected::I128) => visitor.visit_i128(v),
        (Number::U128(v), Expected::U128) => visitor.visit_u128(v),
        (number, expected) => {
            if !coerce_numbers {
                return Err(number.unexpected(expected));
            }

            match (number, expected.number_type()) {
                (Number::I8(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                (Number::U8(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                (Number::I16(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                (Number::U16(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                (Number::I32(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                (Number::U32(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                (Number::F32(v), NumberType::F64) => visitor.visit_f64(v as f64),
                (Number::I64(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                (Number::U64(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                (Number::F64(v), NumberType::F32) if range!(f32 as f64).contains(&v) => {
                    visitor.visit_f32(v as f32)
                }
                (Number::I128(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                (Number::U128(v), _) => {
                    coerce_int!(number, v, expected, visitor)
                }
                _ => Err(number.unexpected(expected)),
            }
        }
    }
}
