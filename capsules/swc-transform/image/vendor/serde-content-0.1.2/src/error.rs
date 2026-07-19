use crate::DataType;
use crate::Number;
use alloc::boxed::Box;
use alloc::format;
use alloc::string::String;
use alloc::string::ToString;
use alloc::vec::Vec;
use core::fmt;

/// Alias for [core::result::Result] with [crate::Error] as the error type.
pub type Result<T> = core::result::Result<T, Error>;

/// The error type returned by this crate.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
#[cfg_attr(feature = "derive", derive(serde::Serialize, serde::Deserialize))]
pub struct Error {
    kind: Box<ErrorKind>,
}

impl Error {
    /// Creates a new unexpected error
    pub fn unexpected(found: Found, expected: Expected) -> Self {
        Self {
            kind: Box::new(ErrorKind::Unexpected { found, expected }),
        }
    }

    /// Borrows the underlying error kind
    pub fn kind(&self) -> &ErrorKind {
        &self.kind
    }

    /// Consumes the error and returns the error kind
    pub fn into_kind(self) -> ErrorKind {
        *self.kind
    }
}

/// The kind of error returned by [`Error::kind`]
#[derive(Debug, Clone, PartialEq, PartialOrd)]
#[cfg_attr(feature = "derive", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive] // In case we add new error variants in future.
pub enum ErrorKind {
    /// Found an unexpected type when deserialising.
    Unexpected {
        /// The type we found (and data where applicable).
        found: Found,
        /// The type we expected.
        expected: Expected,
    },
    /// A custom error message from `serde`.
    Custom(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &*self.kind {
            ErrorKind::Custom(msg) => write!(f, "{msg}"),
            ErrorKind::Unexpected { found, expected } => write!(
                f,
                "failed to deserialize; expected {expected}, found {found}"
            ),
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for Error {}

#[cfg(feature = "serde")]
impl serde::ser::Error for Error {
    fn custom<T>(msg: T) -> Self
    where
        T: fmt::Display,
    {
        Self {
            kind: Box::new(ErrorKind::Custom(msg.to_string())),
        }
    }
}

#[cfg(feature = "serde")]
impl serde::de::Error for Error {
    fn custom<T>(msg: T) -> Self
    where
        T: fmt::Display,
    {
        Self {
            kind: Box::new(ErrorKind::Custom(msg.to_string())),
        }
    }
}

/// The type that was expected.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
#[cfg_attr(feature = "derive", derive(serde::Serialize, serde::Deserialize))]
#[non_exhaustive] // In case we add new number variants in future.
pub enum Expected {
    /// Expected the Rust unit type, `()`.
    Unit,
    /// Expected a Rust boolean.
    Bool,
    /// Expected a Rust character.
    Char,
    /// Expected a Rust string.
    String,
    /// Expected a static string slice.
    StaticStr,
    /// Expected a Rust byte array.
    Bytes,
    /// Expected an array of Rust values.
    Seq,
    /// Expected a map of Rust values.
    Map,
    /// Expected a Rust struct.
    Struct {
        /// The name of the struct.
        name: Option<String>,
        /// The type of the struct
        typ: Option<DataType>,
    },
    /// Expected a Rust enum.
    Enum {
        /// The name of the enum.
        name: Option<String>,
        /// The type of the enum.
        typ: Option<DataType>,
    },
    /// Expected a Rust tuple.
    Tuple(usize),
    /// Expected a struct field or an enum variant.
    Identifier,
    /// Expected an 8-bit signed integer type.
    I8,
    /// Expected an 8-bit unsigned integer type.
    U8,
    /// Expected a 16-bit signed integer type.
    I16,
    /// Expected a 16-bit unsigned integer type.
    U16,
    /// Expected a 32-bit signed integer type.
    I32,
    /// Expected a 32-bit unsigned integer type.
    U32,
    /// Expected a 32-bit floating point type.
    F32,
    /// Expected a 64-bit signed integer type.
    I64,
    /// Expected a 64-bit unsigned integer type.
    U64,
    /// Expected a 32-bit floating point type.
    F64,
    /// Expected a 128-bit signed integer type.
    I128,
    /// Expected a 128-bit unsigned integer type.
    U128,
}

#[doc(hidden)] // Not public API.
impl fmt::Display for Expected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Expected::Unit => write!(f, "a unit"),
            Expected::Bool => write!(f, "a boolean"),
            Expected::I8 => write!(f, "an 8-bit signed integer"),
            Expected::U8 => write!(f, "an 8-bit unsigned integer"),
            Expected::I16 => write!(f, "a 16-bit signed integer"),
            Expected::U16 => write!(f, "a 16-bit unsigned integer"),
            Expected::I32 => write!(f, "a 32-bit signed integer"),
            Expected::U32 => write!(f, "a 32-bit unsigned integer"),
            Expected::F32 => write!(f, "a 32-bit floating point"),
            Expected::I64 => write!(f, "a 64-bit signed integer"),
            Expected::U64 => write!(f, "a 64-bit unsigned integer"),
            Expected::F64 => write!(f, "a 64-bit floating point"),
            Expected::I128 => write!(f, "a 128-bit signed integer"),
            Expected::U128 => write!(f, "a 128-bit unsigned integer"),
            Expected::Char => write!(f, "a single character"),
            Expected::String => write!(f, "a string"),
            Expected::StaticStr => write!(f, "a static string slice"),
            Expected::Bytes => write!(f, "a byte array"),
            Expected::Seq => write!(f, "a sequence"),
            Expected::Map => write!(f, "a map"),
            Expected::Struct { name, typ } => match (name.as_deref(), typ) {
                (None, None) => write!(f, "a struct"),
                (None, Some(typ)) => write!(f, "{typ} struct"),
                (Some(name), None) => write!(f, "a struct named {name}"),
                (Some(name), Some(typ)) => write!(f, "{typ} struct named {name}"),
            },
            Expected::Enum { name, typ } => match (name.as_deref(), typ) {
                (None, None) => write!(f, "an enum variant"),
                (None, Some(typ)) => write!(f, "{typ} enum variant"),
                (Some(name), None) => write!(f, "an enum variant of {name}"),
                (Some(name), Some(typ)) => write!(f, "{typ} enum variant of {name}"),
            },
            Expected::Tuple(len) => write!(f, "a tuple with {len} elements"),
            Expected::Identifier => write!(f, "a struct field name or an enum variant"),
        }
    }
}

#[doc(hidden)] // Not public API.
impl fmt::Display for DataType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DataType::Unit => write!(f, "a unit"),
            DataType::NewType => write!(f, "a newtype"),
            DataType::Tuple => write!(f, "a tuple"),
            DataType::Struct => write!(f, "an object-like"),
        }
    }
}

/// Struct and enum data type for error messages.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
#[cfg_attr(feature = "derive", derive(serde::Serialize, serde::Deserialize))]
pub enum Data {
    /// Unit struct or unit enum variant.
    Unit,
    /// Newtype struct or enum variant.
    NewType(Found),
    /// Tuple struct or enum variant.
    Tuple(Vec<Found>),
    /// Object-like struct or enum variant.
    Struct(Vec<(String, Found)>),
}

/// The type that was found.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
#[cfg_attr(feature = "derive", derive(serde::Serialize, serde::Deserialize))]
pub enum Found {
    /// Found the Rust unit type, `()`.
    Unit,
    /// Found a Rust boolean.
    Bool(bool),
    /// Found any Rust number.
    Number(Number),
    /// Found a Rust character.
    Char(char),
    /// Found a Rust string.
    String(String),
    /// Found a Rust byte array.
    Bytes(Vec<u8>),
    /// Found an array of Rust values.
    Seq(Vec<Found>),
    /// Found a map of Rust values.
    Map(Vec<(Found, Found)>),
    /// Found optional Rust values.
    Option(Option<Box<Found>>),
    /// Found a Rust struct.
    Struct {
        /// The name of the struct.
        name: String,
        /// The data of the struct
        data: Box<Data>,
    },
    /// Found a Rust enum.
    Enum {
        /// The name of the enum.
        name: String,
        /// The variant of the enum.
        variant: String,
        /// The data of the enum.
        data: Box<Data>,
    },
    /// Found a Rust tuple.
    Tuple(Vec<Found>),
    /// Found a struct field or an enum variant.
    Identifier(String),
}

#[doc(hidden)] // Not public API.
impl fmt::Display for Found {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Found::Unit => write!(f, "()"),
            Found::Bool(v) => write!(f, "{v}"),
            Found::Number(v) => match v {
                Number::I8(v) => write!(f, "{v}i8"),
                Number::U8(v) => write!(f, "{v}u8"),
                Number::I16(v) => write!(f, "{v}i16"),
                Number::U16(v) => write!(f, "{v}u16"),
                Number::I32(v) => write!(f, "{v}i32"),
                Number::U32(v) => write!(f, "{v}u32"),
                Number::F32(v) => write!(f, "{v}f32"),
                Number::I64(v) => write!(f, "{v}i64"),
                Number::U64(v) => write!(f, "{v}u64"),
                Number::F64(v) => write!(f, "{v}f64"),
                Number::I128(v) => write!(f, "{v}i128"),
                Number::U128(v) => write!(f, "{v}u128"),
            },
            Found::Char(v) => write!(f, "'{v}'"),
            Found::String(v) => write!(f, "{v:?}"),
            Found::Bytes(v) => write!(f, "&{v:?}"),
            Found::Seq(v) => {
                f.write_str("[")?;
                let data = v.iter().map(Self::to_string).collect::<Vec<_>>();
                f.write_str(&data.join(", "))?;
                f.write_str("]")
            }
            Found::Map(v) => {
                f.write_str("{ ")?;
                let data = v
                    .iter()
                    .map(|(k, v)| format!("{k}: {v}"))
                    .collect::<Vec<_>>();
                f.write_str(&data.join(", "))?;
                f.write_str(" }")
            }
            Found::Option(v) => match v {
                Some(v) => write!(f, "Some({v})"),
                None => write!(f, "None"),
            },
            Found::Struct { name, data } => match data.as_ref() {
                Data::Unit => write!(f, "{name}"),
                Data::NewType(v) => write!(f, "{name}({v})"),
                Data::Tuple(v) => {
                    write!(f, "{name}(")?;
                    let data = v.iter().map(Self::to_string).collect::<Vec<_>>();
                    f.write_str(&data.join(", "))?;
                    f.write_str(")")
                }
                Data::Struct(v) => {
                    write!(f, "{name} {{ ")?;
                    let data = v
                        .iter()
                        .map(|(k, v)| format!("{k}: {v}"))
                        .collect::<Vec<_>>();
                    f.write_str(&data.join(", "))?;
                    f.write_str(" }")
                }
            },
            Found::Enum {
                name,
                variant,
                data,
            } => match data.as_ref() {
                Data::Unit => write!(f, "{name}::{variant}"),
                Data::NewType(v) => write!(f, "{name}::{variant}({v})"),
                Data::Tuple(v) => {
                    write!(f, "{name}::{variant}(")?;
                    let data = v.iter().map(Self::to_string).collect::<Vec<_>>();
                    f.write_str(&data.join(", "))?;
                    f.write_str(")")
                }
                Data::Struct(v) => {
                    write!(f, "{name}::{variant} {{ ")?;
                    let data = v
                        .iter()
                        .map(|(k, v)| format!("{k}: {v}"))
                        .collect::<Vec<_>>();
                    f.write_str(&data.join(", "))?;
                    f.write_str(" }")
                }
            },
            Found::Tuple(v) => {
                f.write_str("(")?;
                let data = v.iter().map(Self::to_string).collect::<Vec<_>>();
                f.write_str(&data.join(", "))?;
                f.write_str(")")
            }
            Found::Identifier(v) => write!(f, "{v}"),
        }
    }
}
