#![cfg(feature = "derive")]
#![cfg(test)]

use crate::Data;
use crate::Enum;
use crate::Number;
use crate::Serializer;
use crate::Struct;
use crate::Value;
use alloc::borrow::Cow;
use alloc::borrow::ToOwned;
use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use serde::Serialize;

const SERIALIZER: Serializer = Serializer::new();

#[test]
fn serialize_bool() {
    assert_eq!(SERIALIZER.serialize(true).unwrap(), Value::Bool(true));
    assert_eq!(SERIALIZER.serialize(false).unwrap(), Value::Bool(false));
}

#[test]
fn serialize_i8() {
    assert_eq!(
        SERIALIZER.serialize(0i8).unwrap(),
        Value::Number(Number::I8(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1i8).unwrap(),
        Value::Number(Number::I8(1))
    );
}

#[test]
fn serialize_i16() {
    assert_eq!(
        SERIALIZER.serialize(0i16).unwrap(),
        Value::Number(Number::I16(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1i16).unwrap(),
        Value::Number(Number::I16(1))
    );
}

#[test]
fn serialize_i32() {
    assert_eq!(
        SERIALIZER.serialize(0i32).unwrap(),
        Value::Number(Number::I32(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1i32).unwrap(),
        Value::Number(Number::I32(1))
    );
}

#[test]
fn serialize_i64() {
    assert_eq!(
        SERIALIZER.serialize(0i64).unwrap(),
        Value::Number(Number::I64(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1i64).unwrap(),
        Value::Number(Number::I64(1))
    );
}

#[test]
fn serialize_i128() {
    assert_eq!(
        SERIALIZER.serialize(0i128).unwrap(),
        Value::Number(Number::I128(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1i128).unwrap(),
        Value::Number(Number::I128(1))
    );
}

#[test]
fn serialize_u8() {
    assert_eq!(
        SERIALIZER.serialize(0u8).unwrap(),
        Value::Number(Number::U8(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1u8).unwrap(),
        Value::Number(Number::U8(1))
    );
}

#[test]
fn serialize_u16() {
    assert_eq!(
        SERIALIZER.serialize(0u16).unwrap(),
        Value::Number(Number::U16(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1u16).unwrap(),
        Value::Number(Number::U16(1))
    );
}

#[test]
fn serialize_u32() {
    assert_eq!(
        SERIALIZER.serialize(0u32).unwrap(),
        Value::Number(Number::U32(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1u32).unwrap(),
        Value::Number(Number::U32(1))
    );
}

#[test]
fn serialize_u64() {
    assert_eq!(
        SERIALIZER.serialize(0u64).unwrap(),
        Value::Number(Number::U64(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1u64).unwrap(),
        Value::Number(Number::U64(1))
    );
}

#[test]
fn serialize_u128() {
    assert_eq!(
        SERIALIZER.serialize(0u128).unwrap(),
        Value::Number(Number::U128(0))
    );
    assert_eq!(
        SERIALIZER.serialize(1u128).unwrap(),
        Value::Number(Number::U128(1))
    );
}

#[test]
fn serialize_f32() {
    assert_eq!(
        SERIALIZER.serialize(0f32).unwrap(),
        Value::Number(Number::F32(0.0))
    );
    assert_eq!(
        SERIALIZER.serialize(1f32).unwrap(),
        Value::Number(Number::F32(1.0))
    );
}

#[test]
fn serialize_f64() {
    assert_eq!(
        SERIALIZER.serialize(0f64).unwrap(),
        Value::Number(Number::F64(0.0))
    );
    assert_eq!(
        SERIALIZER.serialize(1f64).unwrap(),
        Value::Number(Number::F64(1.0))
    );
}

#[test]
fn serialize_char() {
    assert_eq!(SERIALIZER.serialize('a').unwrap(), Value::Char('a'));
}

#[test]
fn serialize_string() {
    assert_eq!(
        SERIALIZER.serialize("foo").unwrap(),
        Value::String(Cow::Borrowed("foo"))
    );
    assert_eq!(
        SERIALIZER.serialize("foo").unwrap(),
        Value::String(Cow::Owned("foo".to_owned()))
    );
    assert_eq!(
        SERIALIZER.serialize(String::new()).unwrap(),
        Value::String(Cow::Borrowed(""))
    );
    assert_eq!(
        SERIALIZER.serialize(String::new()).unwrap(),
        Value::String(Cow::Owned(String::new()))
    );
}

#[test]
fn serialize_bytes() {
    struct Bytes(&'static [u8]);
    impl Serialize for Bytes {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            serializer.serialize_bytes(self.0)
        }
    }
    assert_eq!(
        SERIALIZER.serialize(Bytes(b"")).unwrap(),
        Value::Bytes(Cow::Borrowed(b""))
    );
    assert_eq!(
        SERIALIZER.serialize(Bytes(b"foo")).unwrap(),
        Value::Bytes(Cow::Borrowed(b"foo"))
    );
}

#[test]
fn serialize_option() {
    assert_eq!(
        SERIALIZER.serialize(None::<&str>).unwrap(),
        Value::Option(None)
    );
    assert_eq!(
        SERIALIZER.serialize(Some('a')).unwrap(),
        Value::Option(Some(Box::new(Value::Char('a'))))
    );
}

#[test]
fn serialize_unit() {
    assert_eq!(SERIALIZER.serialize(()).unwrap(), Value::Unit);
    assert_eq!(
        SERIALIZER.serialize(Some(())).unwrap(),
        Value::Option(Some(Box::new(Value::Unit)))
    );
}

#[test]
fn serialize_unit_struct() {
    #[derive(Serialize)]
    struct Foo;
    assert_eq!(
        SERIALIZER.serialize(Foo).unwrap(),
        Value::Struct(Box::new(Struct {
            name: Cow::Borrowed("Foo"),
            data: Data::Unit
        }))
    );
}

#[test]
fn serialize_unit_variant() {
    #[derive(Serialize)]
    enum Foo {
        Bar,
    }
    assert_eq!(
        SERIALIZER.serialize(Foo::Bar).unwrap(),
        Value::Enum(Box::new(Enum {
            name: Cow::Borrowed("Foo"),
            variant_index: 0,
            variant: Cow::Borrowed("Bar"),
            data: Data::Unit
        }))
    );
}

#[test]
fn serialize_newtype_struct() {
    #[derive(Serialize)]
    struct Foo(bool);
    assert_eq!(
        SERIALIZER.serialize(Foo(true)).unwrap(),
        Value::Struct(Box::new(Struct {
            name: Cow::Borrowed("Foo"),
            data: Data::NewType {
                value: Value::Bool(true)
            }
        }))
    );
}

#[test]
fn serialize_newtype_variant() {
    #[derive(Serialize)]
    enum Foo {
        Bar(bool),
    }
    assert_eq!(
        SERIALIZER.serialize(Foo::Bar(true)).unwrap(),
        Value::Enum(Box::new(Enum {
            name: Cow::Borrowed("Foo"),
            variant_index: 0,
            variant: Cow::Borrowed("Bar"),
            data: Data::NewType {
                value: Value::Bool(true)
            }
        }))
    );
}

#[test]
fn serialize_seq() {
    assert_eq!(
        SERIALIZER.serialize(Vec::<bool>::new()).unwrap(),
        Value::Seq(Vec::new())
    );
    assert_eq!(
        SERIALIZER.serialize(vec![true, false]).unwrap(),
        Value::Seq(vec![Value::Bool(true), Value::Bool(false)])
    );
}

#[test]
fn serialize_tuple() {
    assert_eq!(
        SERIALIZER.serialize((true,)).unwrap(),
        Value::Tuple(vec![Value::Bool(true)])
    );
    assert_eq!(
        SERIALIZER.serialize((true, 'a', "foo")).unwrap(),
        Value::Tuple(vec![
            Value::Bool(true),
            Value::Char('a'),
            Value::String(Cow::Borrowed("foo"))
        ])
    );
}

#[test]
fn serialize_tuple_struct() {
    #[derive(Serialize)]
    struct Foo(bool, char);
    assert_eq!(
        SERIALIZER.serialize(Foo(true, 'a')).unwrap(),
        Value::Struct(Box::new(Struct {
            name: Cow::Borrowed("Foo"),
            data: Data::Tuple {
                values: vec![Value::Bool(true), Value::Char('a')],
            }
        }))
    );
}

#[test]
fn serialize_tuple_variant() {
    #[derive(Serialize)]
    enum Foo {
        Bar(bool, char),
    }
    assert_eq!(
        SERIALIZER.serialize(Foo::Bar(true, 'a')).unwrap(),
        Value::Enum(Box::new(Enum {
            name: Cow::Borrowed("Foo"),
            variant_index: 0,
            variant: Cow::Borrowed("Bar"),
            data: Data::Tuple {
                values: vec![Value::Bool(true), Value::Char('a')],
            }
        }))
    );
}

#[test]
fn serialize_map() {
    assert_eq!(
        SERIALIZER.serialize(BTreeMap::<(), ()>::new()).unwrap(),
        Value::Map(Vec::new())
    );
    let mut map = BTreeMap::new();
    map.insert('f', false);
    map.insert('t', true);
    assert_eq!(
        SERIALIZER.serialize(map).unwrap(),
        Value::Map(vec![
            (Value::Char('f'), Value::Bool(false)),
            (Value::Char('t'), Value::Bool(true)),
        ])
    );
}

#[test]
fn serialize_struct() {
    #[derive(Serialize)]
    struct Foo {
        bar: bool,
        baz: char,
    }
    assert_eq!(
        SERIALIZER
            .serialize(Foo {
                bar: true,
                baz: 'a'
            })
            .unwrap(),
        Value::Struct(Box::new(Struct {
            name: Cow::Borrowed("Foo"),
            data: Data::Struct {
                fields: vec![
                    (Cow::Borrowed("bar"), Value::Bool(true)),
                    (Cow::Borrowed("baz"), Value::Char('a'))
                ],
            }
        }))
    );
}

#[test]
fn serialize_struct_variant() {
    #[derive(Serialize)]
    #[allow(dead_code)]
    enum Foo {
        Bar { bar: bool, baz: char },
        Baz { bar: bool, baz: char },
    }
    assert_eq!(
        SERIALIZER
            .serialize(Foo::Baz {
                bar: true,
                baz: 'a',
            })
            .unwrap(),
        Value::Enum(Box::new(Enum {
            name: Cow::Borrowed("Foo"),
            variant_index: 1,
            variant: Cow::Borrowed("Baz"),
            data: Data::Struct {
                fields: vec![
                    (Cow::Borrowed("bar"), Value::Bool(true)),
                    (Cow::Borrowed("baz"), Value::Char('a'))
                ],
            }
        }))
    );
}
