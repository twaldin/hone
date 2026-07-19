#![cfg(feature = "derive")]
#![cfg(test)]

use crate::Data;
use crate::Deserializer;
use crate::Enum;
use crate::Number;
use crate::Struct;
use crate::Value;
use alloc::borrow::Cow;
use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::fmt;
use serde::de::Visitor;
use serde::Deserialize;

#[test]
fn deserialize_bool() {
    assert!(Deserializer::new(Value::Bool(true))
        .deserialize::<bool>()
        .unwrap());
    assert!(!Deserializer::new(Value::Bool(false))
        .deserialize::<bool>()
        .unwrap());
}

#[test]
fn deserialize_i8() {
    assert_eq!(
        0i8,
        Deserializer::new(Value::Number(Number::I8(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1i8,
        Deserializer::new(Value::Number(Number::I8(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_i16() {
    assert_eq!(
        0i16,
        Deserializer::new(Value::Number(Number::I16(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1i16,
        Deserializer::new(Value::Number(Number::I16(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_i32() {
    assert_eq!(
        0i32,
        Deserializer::new(Value::Number(Number::I32(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1i32,
        Deserializer::new(Value::Number(Number::I32(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_i64() {
    assert_eq!(
        0i64,
        Deserializer::new(Value::Number(Number::I64(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1i64,
        Deserializer::new(Value::Number(Number::I64(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_i128() {
    assert_eq!(
        0i128,
        Deserializer::new(Value::Number(Number::I128(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1i128,
        Deserializer::new(Value::Number(Number::I128(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_u8() {
    assert_eq!(
        0u8,
        Deserializer::new(Value::Number(Number::U8(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1u8,
        Deserializer::new(Value::Number(Number::U8(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_u16() {
    assert_eq!(
        0u16,
        Deserializer::new(Value::Number(Number::U16(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1u16,
        Deserializer::new(Value::Number(Number::U16(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_u32() {
    assert_eq!(
        0u32,
        Deserializer::new(Value::Number(Number::U32(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1u32,
        Deserializer::new(Value::Number(Number::U32(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_u64() {
    assert_eq!(
        0u64,
        Deserializer::new(Value::Number(Number::U64(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1u64,
        Deserializer::new(Value::Number(Number::U64(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_u128() {
    assert_eq!(
        0u128,
        Deserializer::new(Value::Number(Number::U128(0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1u128,
        Deserializer::new(Value::Number(Number::U128(1)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_f32() {
    assert_eq!(
        0f32,
        Deserializer::new(Value::Number(Number::F32(0.0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1f32,
        Deserializer::new(Value::Number(Number::F32(1.0)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_f64() {
    assert_eq!(
        0f64,
        Deserializer::new(Value::Number(Number::F64(0.0)))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        1f64,
        Deserializer::new(Value::Number(Number::F64(1.0)))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_char() {
    assert_eq!(
        'a',
        Deserializer::new(Value::Char('a')).deserialize().unwrap()
    );
}

#[test]
fn deserialize_string() {
    let foo = String::from("foo");
    assert_eq!(
        foo,
        Deserializer::new(Value::String(Cow::Borrowed(&foo)))
            .deserialize::<&str>()
            .unwrap()
    );
    assert_eq!(
        foo,
        Deserializer::new(Value::String(Cow::Owned(foo.clone())))
            .deserialize::<String>()
            .unwrap()
    );
    assert_eq!(
        String::new(),
        Deserializer::new(Value::String(Cow::Borrowed("")))
            .deserialize::<&str>()
            .unwrap()
    );
    assert_eq!(
        String::new(),
        Deserializer::new(Value::String(Cow::Owned(String::new())))
            .deserialize::<String>()
            .unwrap()
    );
}

#[test]
fn deserialize_bytes() {
    #[derive(Debug, PartialEq)]
    struct Bytes(&'static [u8]);
    impl Deserialize<'static> for Bytes {
        fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
        where
            D: serde::Deserializer<'static>,
        {
            struct BytesVisitor;
            impl Visitor<'static> for BytesVisitor {
                type Value = Bytes;

                fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                    formatter.write_str("bytes")
                }

                fn visit_borrowed_bytes<E>(self, v: &'static [u8]) -> Result<Self::Value, E>
                where
                    E: serde::de::Error,
                {
                    Ok(Bytes(v))
                }
            }

            deserializer.deserialize_bytes(BytesVisitor)
        }
    }
    assert_eq!(
        Bytes(b""),
        Deserializer::new(Value::Bytes(Cow::Borrowed(b"")))
            .deserialize()
            .unwrap(),
    );
    assert_eq!(
        Bytes(b"foo"),
        Deserializer::new(Value::Bytes(Cow::Borrowed(b"foo")))
            .deserialize()
            .unwrap(),
    );
}

#[test]
fn deserialize_option() {
    assert_eq!(
        None::<&str>,
        Deserializer::new(Value::Option(None))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        Some('a'),
        Deserializer::new(Value::Option(Some(Box::new(Value::Char('a')))))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        Some(()),
        Deserializer::new(Value::Unit).deserialize().unwrap()
    );
    assert_eq!(
        Some(true),
        Deserializer::new(Value::Bool(true)).deserialize().unwrap()
    );
}

#[test]
fn deserialize_unit() {
    Deserializer::new(Value::Unit).deserialize::<()>().unwrap();
    assert_eq!(
        Some(()),
        Deserializer::new(Value::Option(Some(Box::new(Value::Unit))))
            .deserialize()
            .unwrap(),
    );
}

#[test]
fn deserialize_unit_struct() {
    #[derive(Debug, Deserialize, PartialEq)]
    struct Foo;
    assert_eq!(
        Foo,
        Deserializer::new(Value::Struct(Box::new(Struct {
            name: Cow::Borrowed("Foo"),
            data: Data::Unit
        })))
        .deserialize()
        .unwrap()
    );
    assert_eq!(Foo, Deserializer::new(Value::Unit).deserialize().unwrap());
}

#[test]
fn deserialize_unit_variant() {
    #[derive(Debug, Deserialize, PartialEq)]
    enum Foo {
        Bar,
    }
    assert_eq!(
        Foo::Bar,
        Deserializer::new(Value::Enum(Box::new(Enum {
            name: Cow::Borrowed("Foo"),
            variant_index: 0,
            variant: Cow::Borrowed("Bar"),
            data: Data::Unit
        })))
        .deserialize()
        .unwrap()
    );
    assert_eq!(
        Foo::Bar,
        Deserializer::new(Value::String(Cow::Borrowed("Bar")))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_newtype_struct() {
    #[derive(Debug, Deserialize, PartialEq)]
    struct Foo(bool);
    assert_eq!(
        Foo(true),
        Deserializer::new(Value::Struct(Box::new(Struct {
            name: Cow::Borrowed("Foo"),
            data: Data::NewType {
                value: Value::Bool(true)
            }
        })))
        .deserialize()
        .unwrap()
    );
    assert_eq!(
        Foo(true),
        Deserializer::new(Value::Bool(true)).deserialize().unwrap()
    );
}

#[test]
fn deserialize_newtype_variant() {
    #[derive(Debug, Deserialize, PartialEq)]
    enum Foo {
        Bar(bool),
    }
    assert_eq!(
        Foo::Bar(true),
        Deserializer::new(Value::Enum(Box::new(Enum {
            name: Cow::Borrowed("Foo"),
            variant_index: 0,
            variant: Cow::Borrowed("Bar"),
            data: Data::NewType {
                value: Value::Bool(true)
            }
        })))
        .deserialize()
        .unwrap()
    );
    assert_eq!(
        Foo::Bar(true),
        Deserializer::new(Value::Map(vec![(
            Value::String(Cow::Borrowed("Bar")),
            Value::Bool(true)
        )]))
        .deserialize()
        .unwrap()
    );
}

#[test]
fn deserialize_seq() {
    assert_eq!(
        Vec::<bool>::new(),
        Deserializer::new(Value::Seq(Vec::new()))
            .deserialize::<Vec<_>>()
            .unwrap()
    );
    assert_eq!(
        vec![true, false],
        Deserializer::new(Value::Seq(vec![Value::Bool(true), Value::Bool(false)]))
            .deserialize::<Vec<_>>()
            .unwrap()
    );
}

#[test]
fn deserialize_tuple() {
    assert_eq!(
        (true,),
        Deserializer::new(Value::Tuple(vec![Value::Bool(true)]))
            .deserialize()
            .unwrap()
    );
    assert_eq!(
        (true, 'a', "foo"),
        Deserializer::new(Value::Tuple(vec![
            Value::Bool(true),
            Value::Char('a'),
            Value::String(Cow::Borrowed("foo"))
        ]))
        .deserialize()
        .unwrap()
    );
    assert_eq!(
        (true, 'a', "foo"),
        Deserializer::new(Value::Seq(vec![
            Value::Bool(true),
            Value::Char('a'),
            Value::String(Cow::Borrowed("foo"))
        ]))
        .deserialize()
        .unwrap()
    );
}

#[test]
fn deserialize_tuple_struct() {
    #[derive(Debug, Deserialize, PartialEq)]
    struct Foo(bool, char);
    assert_eq!(
        Foo(true, 'a'),
        Deserializer::new(Value::Struct(Box::new(Struct {
            name: Cow::Borrowed("Foo"),
            data: Data::Tuple {
                values: vec![Value::Bool(true), Value::Char('a')],
            }
        })))
        .deserialize()
        .unwrap()
    );
    assert_eq!(
        Foo(true, 'a'),
        Deserializer::new(Value::Seq(vec![Value::Bool(true), Value::Char('a')]))
            .deserialize()
            .unwrap()
    );
}

#[test]
fn deserialize_tuple_variant() {
    #[derive(Debug, Deserialize, PartialEq)]
    enum Foo {
        Bar(bool, char),
    }
    assert_eq!(
        Foo::Bar(true, 'a'),
        Deserializer::new(Value::Enum(Box::new(Enum {
            name: Cow::Borrowed("Foo"),
            variant_index: 0,
            variant: Cow::Borrowed("Bar"),
            data: Data::Tuple {
                values: vec![Value::Bool(true), Value::Char('a')],
            }
        })))
        .deserialize()
        .unwrap()
    );
    assert_eq!(
        Foo::Bar(true, 'a'),
        Deserializer::new(Value::Map(vec![(
            Value::String(Cow::Borrowed("Bar")),
            Value::Seq(vec![Value::Bool(true), Value::Char('a')])
        )]))
        .deserialize()
        .unwrap()
    );
}

#[test]
fn deserialize_map() {
    assert_eq!(
        BTreeMap::<(), ()>::new(),
        Deserializer::new(Value::Map(Vec::new()))
            .deserialize()
            .unwrap()
    );
    let mut map = BTreeMap::new();
    map.insert('f', false);
    map.insert('t', true);
    assert_eq!(
        map,
        Deserializer::new(Value::Map(vec![
            (Value::Char('f'), Value::Bool(false)),
            (Value::Char('t'), Value::Bool(true)),
        ]))
        .deserialize()
        .unwrap()
    );
}

#[test]
fn deserialize_struct() {
    #[derive(Debug, Deserialize, PartialEq)]
    struct Foo {
        bar: bool,
        baz: char,
    }
    assert_eq!(
        Foo {
            bar: true,
            baz: 'a'
        },
        Deserializer::new(Value::Struct(Box::new(Struct {
            name: Cow::Borrowed("Foo"),
            data: Data::Struct {
                fields: vec![
                    (Cow::Borrowed("bar"), Value::Bool(true)),
                    (Cow::Borrowed("baz"), Value::Char('a'))
                ],
            }
        })))
        .deserialize()
        .unwrap()
    );
    assert_eq!(
        Foo {
            bar: true,
            baz: 'a'
        },
        Deserializer::new(Value::Map(vec![
            (Value::String(Cow::Borrowed("bar")), Value::Bool(true)),
            (Value::String(Cow::Borrowed("baz")), Value::Char('a'))
        ]))
        .deserialize()
        .unwrap()
    );
}

#[test]
fn deserialize_struct_variant() {
    #[derive(Debug, Deserialize, PartialEq)]
    enum Foo {
        Bar { bar: bool, baz: char },
    }
    assert_eq!(
        Foo::Bar {
            bar: true,
            baz: 'a',
        },
        Deserializer::new(Value::Enum(Box::new(Enum {
            name: Cow::Borrowed("Foo"),
            variant_index: 0,
            variant: Cow::Borrowed("Bar"),
            data: Data::Struct {
                fields: vec![
                    (Cow::Borrowed("bar"), Value::Bool(true)),
                    (Cow::Borrowed("baz"), Value::Char('a'))
                ],
            }
        })))
        .deserialize()
        .unwrap()
    );
    assert_eq!(
        Foo::Bar {
            bar: true,
            baz: 'a',
        },
        Deserializer::new(Value::Map(vec![(
            Value::String(Cow::Borrowed("Bar")),
            Value::Map(vec![
                (Value::String(Cow::Borrowed("bar")), Value::Bool(true)),
                (Value::String(Cow::Borrowed("baz")), Value::Char('a'))
            ])
        )]))
        .deserialize()
        .unwrap()
    );
}
