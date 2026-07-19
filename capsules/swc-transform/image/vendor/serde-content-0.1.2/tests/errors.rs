#![cfg(feature = "derive")]

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec;
use alloc::vec::Vec;
use core::fmt;
use serde::de::Visitor;
use serde::Deserialize;
use serde::Serialize;
use serde_content::DataType;
use serde_content::Deserializer;
use serde_content::Error;
use serde_content::Expected;
use serde_content::Found;
use serde_content::FoundData;
use serde_content::Number;
use serde_content::Serializer;

fn check_error<T>(value: impl Serialize, found: Found, expected: Expected, message: &str)
where
    T: Deserialize<'static> + fmt::Debug,
{
    let value = Serializer::new().serialize(value).unwrap();
    let error = Deserializer::new(value).deserialize::<T>().unwrap_err();
    let expected = Error::unexpected(found, expected);
    assert_eq!(error, expected);
    assert_eq!(
        error.to_string(),
        format!("failed to deserialize; {message}"),
    );
}

#[test]
fn bool_errors() {
    check_error::<()>(
        true,
        Found::Bool(true),
        Expected::Unit,
        "expected a unit, found true",
    );
    check_error::<bool>(
        (),
        Found::Unit,
        Expected::Bool,
        "expected a boolean, found ()",
    );
}

#[test]
fn i8_errors() {
    for v in [i8::MIN, 0, i8::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::I8(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}i8"),
        );
        check_error::<i8>(
            (),
            Found::Unit,
            Expected::I8,
            "expected an 8-bit signed integer, found ()",
        );
    }
}

#[test]
fn i16_errors() {
    for v in [i16::MIN, 0, i16::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::I16(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}i16"),
        );
        check_error::<i16>(
            (),
            Found::Unit,
            Expected::I16,
            "expected a 16-bit signed integer, found ()",
        );
    }
}

#[test]
fn i32_errors() {
    for v in [i32::MIN, 0, i32::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::I32(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}i32"),
        );
        check_error::<i32>(
            (),
            Found::Unit,
            Expected::I32,
            "expected a 32-bit signed integer, found ()",
        );
    }
}

#[test]
fn i64_errors() {
    for v in [i64::MIN, 0, i64::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::I64(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}i64"),
        );
        check_error::<i64>(
            (),
            Found::Unit,
            Expected::I64,
            "expected a 64-bit signed integer, found ()",
        );
    }
}

#[test]
fn i128_errors() {
    for v in [i128::MIN, 0, i128::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::I128(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}i128"),
        );
        check_error::<i128>(
            (),
            Found::Unit,
            Expected::I128,
            "expected a 128-bit signed integer, found ()",
        );
    }
}

#[test]
fn u8_errors() {
    for v in [u8::MIN, u8::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::U8(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}u8"),
        );
        check_error::<u8>(
            (),
            Found::Unit,
            Expected::U8,
            "expected an 8-bit unsigned integer, found ()",
        );
    }
}

#[test]
fn u16_errors() {
    for v in [u16::MIN, u16::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::U16(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}u16"),
        );
        check_error::<u16>(
            (),
            Found::Unit,
            Expected::U16,
            "expected a 16-bit unsigned integer, found ()",
        );
    }
}

#[test]
fn u32_errors() {
    for v in [u32::MIN, u32::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::U32(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}u32"),
        );
        check_error::<u32>(
            (),
            Found::Unit,
            Expected::U32,
            "expected a 32-bit unsigned integer, found ()",
        );
    }
}

#[test]
fn u64_errors() {
    for v in [u64::MIN, u64::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::U64(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}u64"),
        );
        check_error::<u64>(
            (),
            Found::Unit,
            Expected::U64,
            "expected a 64-bit unsigned integer, found ()",
        );
    }
}

#[test]
fn u128_errors() {
    for v in [u128::MIN, u128::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::U128(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}u128"),
        );
        check_error::<u128>(
            (),
            Found::Unit,
            Expected::U128,
            "expected a 128-bit unsigned integer, found ()",
        );
    }
}

#[test]
fn f32_errors() {
    for v in [f32::MIN, 0.0, f32::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::F32(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}f32"),
        );
        check_error::<f32>(
            (),
            Found::Unit,
            Expected::F32,
            "expected a 32-bit floating point, found ()",
        );
    }
}

#[test]
fn f64_errors() {
    for v in [f64::MIN, 0.0, f64::MAX] {
        check_error::<()>(
            v,
            Found::Number(Number::F64(v)),
            Expected::Unit,
            &format!("expected a unit, found {v}f64"),
        );
        check_error::<f64>(
            (),
            Found::Unit,
            Expected::F64,
            "expected a 64-bit floating point, found ()",
        );
    }
}

#[test]
fn char_errors() {
    let v = 'a';
    check_error::<()>(
        v,
        Found::Char(v),
        Expected::Unit,
        &format!("expected a unit, found '{v}'"),
    );
    check_error::<char>(
        (),
        Found::Unit,
        Expected::Char,
        "expected a single character, found ()",
    );
}

#[test]
fn string_errors() {
    for v in [String::new(), "foo".to_owned()] {
        check_error::<()>(
            v.clone(),
            Found::String(v.clone()),
            Expected::Unit,
            &format!("expected a unit, found {v:?}"),
        );
        check_error::<String>(
            (),
            Found::Unit,
            Expected::String,
            "expected a string, found ()",
        );
    }
}

#[test]
fn bytes_errors() {
    #[derive(Debug, Clone, PartialEq)]
    struct Bytes(Vec<u8>);
    impl Serialize for Bytes {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            serializer.serialize_bytes(&self.0)
        }
    }
    impl<'de> Deserialize<'de> for Bytes {
        fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            struct BytesVisitor;
            impl<'de> Visitor<'de> for BytesVisitor {
                type Value = Bytes;

                fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                    formatter.write_str("bytes")
                }

                fn visit_byte_buf<E>(self, v: Vec<u8>) -> Result<Self::Value, E>
                where
                    E: serde::de::Error,
                {
                    Ok(Bytes(v))
                }
            }

            deserializer.deserialize_byte_buf(BytesVisitor)
        }
    }
    let v = Bytes("foo".as_bytes().to_vec());
    check_error::<()>(
        v.clone(),
        Found::Bytes(v.0),
        Expected::Unit,
        "expected a unit, found &[102, 111, 111]",
    );
    check_error::<&[u8]>(
        (),
        Found::Unit,
        Expected::Bytes,
        "expected a byte array, found ()",
    );
}

#[test]
fn option_errors() {
    check_error::<()>(
        None::<&str>,
        Found::Option(None),
        Expected::Unit,
        "expected a unit, found None",
    );
    let v = "foo".to_owned();
    check_error::<()>(
        Some(v.clone()),
        Found::Option(Some(Box::new(Found::String(v)))),
        Expected::Unit,
        r#"expected a unit, found Some("foo")"#,
    );
    check_error::<Option<&str>>(
        (),
        Found::Unit,
        Expected::String,
        "expected a string, found ()",
    );
}

#[test]
fn unit_struct_errors() {
    #[derive(Debug, Serialize, Deserialize)]
    struct Foo;
    check_error::<()>(
        Foo,
        Found::Struct {
            name: "Foo".to_owned(),
            data: Box::new(FoundData::Unit),
        },
        Expected::Unit,
        "expected a unit, found Foo",
    );
}

#[test]
fn unit_variant_errors() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Foo {
        Bar,
    }
    check_error::<()>(
        Foo::Bar,
        Found::Enum {
            name: "Foo".to_owned(),
            variant: "Bar".to_owned(),
            data: Box::new(FoundData::Unit),
        },
        Expected::Unit,
        "expected a unit, found Foo::Bar",
    );
    check_error::<Foo>(
        (),
        Found::Unit,
        Expected::Enum {
            name: Some("Foo".to_owned()),
            typ: None,
        },
        "expected an enum variant of Foo, found ()",
    );
}

#[test]
fn newtype_struct_errors() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo(bool);
    let v = true;
    check_error::<()>(
        Foo(v),
        Found::Struct {
            name: "Foo".to_owned(),
            data: Box::new(FoundData::NewType(Found::Bool(v))),
        },
        Expected::Unit,
        "expected a unit, found Foo(true)",
    );
    check_error::<Foo>(
        (),
        Found::Unit,
        Expected::Bool,
        "expected a boolean, found ()",
    );
}

#[test]
fn newtype_variant_errors() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Foo {
        Bar(bool),
    }
    let v = true;
    check_error::<()>(
        Foo::Bar(v),
        Found::Enum {
            name: "Foo".to_owned(),
            variant: "Bar".to_owned(),
            data: Box::new(FoundData::NewType(Found::Bool(v))),
        },
        Expected::Unit,
        "expected a unit, found Foo::Bar(true)",
    );
    check_error::<Foo>(
        (),
        Found::Unit,
        Expected::Enum {
            name: Some("Foo".to_owned()),
            typ: None,
        },
        "expected an enum variant of Foo, found ()",
    );
}

#[test]
fn seq_errors() {
    let v = vec![true, false];
    check_error::<()>(
        v.clone(),
        Found::Seq(v.into_iter().map(Found::Bool).collect()),
        Expected::Unit,
        "expected a unit, found [true, false]",
    );
    check_error::<Vec<bool>>(
        (),
        Found::Unit,
        Expected::Seq,
        "expected a sequence, found ()",
    );
}

#[test]
fn tuple_errors() {
    let v = (true, 'a', "foo".to_owned());
    let tup = vec![
        Found::Bool(v.0),
        Found::Char(v.1),
        Found::String(v.2.clone()),
    ];
    check_error::<()>(
        v.clone(),
        Found::Tuple(tup),
        Expected::Unit,
        r#"expected a unit, found (true, 'a', "foo")"#,
    );
    check_error::<(bool, usize)>(
        (),
        Found::Unit,
        Expected::Tuple(2),
        "expected a tuple with 2 elements, found ()",
    );
}

#[test]
fn tuple_struct_errors() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo(bool, char);
    check_error::<()>(
        Foo(true, 'a'),
        Found::Struct {
            name: "Foo".to_owned(),
            data: Box::new(FoundData::Tuple(vec![Found::Bool(true), Found::Char('a')])),
        },
        Expected::Unit,
        "expected a unit, found Foo(true, 'a')",
    );
    check_error::<Foo>(
        (),
        Found::Unit,
        Expected::Struct {
            name: Some("Foo".to_owned()),
            typ: Some(DataType::Tuple),
        },
        "expected a tuple struct named Foo, found ()",
    );
}

#[test]
fn tuple_variant_errors() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Foo {
        Bar(bool, char),
    }
    check_error::<()>(
        Foo::Bar(true, 'a'),
        Found::Enum {
            name: "Foo".to_owned(),
            variant: "Bar".to_owned(),
            data: Box::new(FoundData::Tuple(vec![Found::Bool(true), Found::Char('a')])),
        },
        Expected::Unit,
        "expected a unit, found Foo::Bar(true, 'a')",
    );
    check_error::<Foo>(
        (),
        Found::Unit,
        Expected::Enum {
            name: Some("Foo".to_owned()),
            typ: None,
        },
        "expected an enum variant of Foo, found ()",
    );
}

#[test]
fn map_errors() {
    let mut v = BTreeMap::new();
    v.insert('f', false);
    v.insert('t', true);
    let map = v
        .clone()
        .into_iter()
        .map(|(k, v)| (Found::Char(k), Found::Bool(v)))
        .collect();
    check_error::<()>(
        v,
        Found::Map(map),
        Expected::Unit,
        "expected a unit, found { 'f': false, 't': true }",
    );
    check_error::<BTreeMap<String, bool>>(
        (),
        Found::Unit,
        Expected::Map,
        "expected a map, found ()",
    );
}

#[test]
fn struct_errors() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo {
        bar: bool,
        baz: char,
    }
    let v = Foo {
        bar: true,
        baz: 'a',
    };
    check_error::<()>(
        v,
        Found::Struct {
            name: "Foo".to_owned(),
            data: Box::new(FoundData::Struct(vec![
                ("bar".to_owned(), Found::Bool(true)),
                ("baz".to_owned(), Found::Char('a')),
            ])),
        },
        Expected::Unit,
        "expected a unit, found Foo { bar: true, baz: 'a' }",
    );
    check_error::<Foo>(
        (),
        Found::Unit,
        Expected::Struct {
            name: Some("Foo".to_owned()),
            typ: Some(DataType::Struct),
        },
        "expected an object-like struct named Foo, found ()",
    );
}

#[test]
fn struct_variant_errors() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Foo {
        Bar { bar: bool, baz: char },
    }
    let v = Foo::Bar {
        bar: true,
        baz: 'a',
    };
    check_error::<()>(
        v,
        Found::Enum {
            name: "Foo".to_owned(),
            variant: "Bar".to_owned(),
            data: Box::new(FoundData::Struct(vec![
                ("bar".to_owned(), Found::Bool(true)),
                ("baz".to_owned(), Found::Char('a')),
            ])),
        },
        Expected::Unit,
        "expected a unit, found Foo::Bar { bar: true, baz: 'a' }",
    );
    check_error::<Foo>(
        (),
        Found::Unit,
        Expected::Enum {
            name: Some("Foo".to_owned()),
            typ: None,
        },
        "expected an enum variant of Foo, found ()",
    );
}
