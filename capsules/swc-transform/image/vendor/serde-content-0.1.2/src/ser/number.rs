use crate::Number;
use serde::ser;

impl ser::Serialize for Number {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: ser::Serializer,
    {
        match *self {
            Number::I8(v) => serializer.serialize_i8(v),
            Number::U8(v) => serializer.serialize_u8(v),
            Number::I16(v) => serializer.serialize_i16(v),
            Number::U16(v) => serializer.serialize_u16(v),
            Number::I32(v) => serializer.serialize_i32(v),
            Number::U32(v) => serializer.serialize_u32(v),
            Number::F32(v) => serializer.serialize_f32(v),
            Number::I64(v) => serializer.serialize_i64(v),
            Number::U64(v) => serializer.serialize_u64(v),
            Number::F64(v) => serializer.serialize_f64(v),
            Number::I128(v) => serializer.serialize_i128(v),
            Number::U128(v) => serializer.serialize_u128(v),
        }
    }
}
