#![cfg(feature = "derive")]
#![allow(clippy::disallowed_names)]

extern crate alloc;

use alloc::string::String;
use serde::{Deserialize, Serialize};
use serde_content::{Deserializer, Serializer};

#[test]
fn string() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo(String);
    //
    let serializer = Serializer::new();
    let foo = Foo(String::new());
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
    //
    let foo = Foo("bar".to_owned());
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
}

#[test]
fn newtype_struct() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Bar(String);
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo(Bar);
    //
    let serializer = Serializer::new();
    let foo = Foo(Bar(String::new()));
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
    //
    let foo = Foo(Bar("bar".to_owned()));
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
}

#[test]
fn tuple_struct() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Bar(String, usize);
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo(Bar);
    //
    let serializer = Serializer::new();
    let foo = Foo(Bar(String::new(), 0));
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
    //
    let foo = Foo(Bar("bar".to_owned(), 56));
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
}

#[test]
fn object_struct() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Bar {
        foo: String,
        baz: usize,
    }
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo(Bar);
    //
    let serializer = Serializer::new();
    let foo = Foo(Bar {
        foo: String::new(),
        baz: 0,
    });
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
    //
    let foo = Foo(Bar {
        foo: "bar".to_owned(),
        baz: 56,
    });
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
}

#[test]
fn newtype_enum() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Bar {
        Baz(String),
    }
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo(Bar);
    //
    let serializer = Serializer::new();
    let foo = Foo(Bar::Baz(String::new()));
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
    //
    let foo = Foo(Bar::Baz("bar".to_owned()));
    let value = serializer.serialize(&foo.0).unwrap();
    assert_eq!(foo, Deserializer::new(value).deserialize().unwrap());
}
