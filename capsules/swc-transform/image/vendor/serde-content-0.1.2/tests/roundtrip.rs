#![cfg(feature = "derive")]

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec;
use alloc::vec::Vec;
use core::fmt;
use serde::de::Visitor;
use serde::Deserialize;
use serde::Serialize;
use serde_content::Deserializer;
use serde_content::Serializer;

fn roundtrip<T>(v: T)
where
    T: Serialize + Deserialize<'static> + fmt::Debug + PartialEq,
{
    let value = Serializer::new().serialize(&v).unwrap();
    let deserializer = Deserializer::new(value.clone());
    assert_eq!(v, deserializer.clone().deserialize().unwrap());
    assert_eq!(value, deserializer.deserialize().unwrap());
}

#[test]
fn roundtrip_bool() {
    for v in [true, false] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_i8() {
    for v in [i8::MIN, 0, i8::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_i16() {
    for v in [i16::MIN, 0, i16::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_i32() {
    for v in [i32::MIN, 0, i32::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_i64() {
    for v in [i64::MIN, 0, i64::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_i128() {
    for v in [i128::MIN, 0, i128::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_u8() {
    for v in [u8::MIN, u8::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_u16() {
    for v in [u16::MIN, u16::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_u32() {
    for v in [u32::MIN, u32::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_u64() {
    for v in [u64::MIN, u64::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_u128() {
    for v in [u128::MIN, u128::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_f32() {
    for v in [f32::MIN, 0.0, f32::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_f64() {
    for v in [f64::MIN, 0.0, f64::MAX] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_char() {
    roundtrip('a');
}

#[test]
fn roundtrip_string() {
    for v in [String::new(), String::from("foo")] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_bytes() {
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
    impl<'de> serde::Deserialize<'de> for Bytes {
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
    for v in [Bytes(Vec::new()), Bytes("foo".as_bytes().to_vec())] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_option() {
    for v in [None, Some(String::new()), Some(String::from("foo"))] {
        roundtrip(v);
    }
}

#[test]
fn roundtrip_unit() {
    roundtrip(());
    roundtrip(Some(()));
}

/* #[test]
fn roundtrip_unit_struct() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo;
    roundtrip(Foo);
}

#[test]
fn roundtrip_unit_variant() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Foo {
        Bar,
    }
    roundtrip(Foo::Bar);
}

#[test]
fn roundtrip_newtype_struct() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo(bool);
    roundtrip(Foo(true));
}

#[test]
fn roundtrip_newtype_variant() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Foo {
        Bar(bool),
    }
    roundtrip(Foo::Bar(true));
} */

#[test]
fn roundtrip_seq() {
    for v in [Vec::new(), vec![true, false]] {
        roundtrip(v);
    }
}

/* #[test]
fn roundtrip_tuple() {
    roundtrip((true,));
    roundtrip((true, 'a', "foo".to_owned()));
}

#[test]
fn roundtrip_tuple_struct() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo(bool, char);
    roundtrip(Foo(true, 'a'));
}

#[test]
fn roundtrip_tuple_variant() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Foo {
        Bar(bool, char),
    }
    roundtrip(Foo::Bar(true, 'a'));
} */

#[test]
fn roundtrip_map() {
    let mut map = BTreeMap::new();
    map.insert('f', false);
    map.insert('t', true);
    for v in [BTreeMap::new(), map] {
        roundtrip(v);
    }
}

/* #[test]
fn roundtrip_struct() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo {
        bar: bool,
        baz: char,
    }
    roundtrip(Foo {
        bar: true,
        baz: 'a',
    });
}

#[test]
fn roundtrip_struct_variant() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Foo {
        Bar { bar: bool, baz: char },
    }
    roundtrip(Foo::Bar {
        bar: true,
        baz: 'a',
    });
} */
