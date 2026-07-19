/// A containter for all Rust number types.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
#[non_exhaustive] // In case Rust introduces new number types.
pub enum Number {
    /// Holds an 8-bit signed integer type.
    I8(i8),
    /// Holds an 8-bit unsigned integer type.
    U8(u8),

    /// Holds a 16-bit signed integer type.
    I16(i16),
    /// Holds a 16-bit unsigned integer type.
    U16(u16),

    /// Holds a 32-bit signed integer type.
    I32(i32),
    /// Holds a 32-bit unsigned integer type.
    U32(u32),
    /// Holds a 32-bit floating point type.
    F32(f32),

    /// Holds a 64-bit signed integer type.
    I64(i64),
    /// Holds a 64-bit unsigned integer type.
    U64(u64),
    /// Holds a 32-bit floating point type.
    F64(f64),

    /// Holds a 128-bit signed integer type.
    I128(i128),
    /// Holds a 128-bit unsigned integer type.
    U128(u128),
}

impl From<i8> for Number {
    fn from(value: i8) -> Self {
        Self::I8(value)
    }
}

impl From<u8> for Number {
    fn from(value: u8) -> Self {
        Self::U8(value)
    }
}

impl From<i16> for Number {
    fn from(value: i16) -> Self {
        Self::I16(value)
    }
}

impl From<u16> for Number {
    fn from(value: u16) -> Self {
        Self::U16(value)
    }
}

impl From<i32> for Number {
    fn from(value: i32) -> Self {
        Self::I32(value)
    }
}

impl From<u32> for Number {
    fn from(value: u32) -> Self {
        Self::U32(value)
    }
}

impl From<f32> for Number {
    fn from(value: f32) -> Self {
        Self::F32(value)
    }
}

impl From<i64> for Number {
    fn from(value: i64) -> Self {
        Self::I64(value)
    }
}

impl From<u64> for Number {
    fn from(value: u64) -> Self {
        Self::U64(value)
    }
}

impl From<f64> for Number {
    fn from(value: f64) -> Self {
        Self::F64(value)
    }
}

impl From<i128> for Number {
    fn from(value: i128) -> Self {
        Self::I128(value)
    }
}

impl From<u128> for Number {
    fn from(value: u128) -> Self {
        Self::U128(value)
    }
}
