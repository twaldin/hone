#![cfg(feature = "derive")]
#![allow(clippy::disallowed_names)]

extern crate alloc;

use alloc::borrow::Cow;
use serde::Deserialize;
use serde::Serialize;
use serde_content::Data;
use serde_content::Deserializer;
use serde_content::Serializer;
use serde_content::Struct;
use serde_content::Value;

#[test]
fn flatten() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Foo {
        bar: bool,
    }

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Baz {
        #[serde(flatten)]
        foo: Foo,
    }

    let foo = Foo { bar: true };
    let baz = Baz { foo };

    let value = Serializer::new().serialize(&baz).unwrap();
    assert_eq!(baz, Deserializer::new(value).deserialize().unwrap());
}

#[test]
fn skip() {
    #[derive(Debug, Serialize)]
    struct Foo {
        bar: bool,
        #[serde(skip)]
        _baz: usize,
    }

    let foo = Foo { bar: true, _baz: 9 };

    let value = Serializer::new().serialize(&foo).unwrap();
    let expected = Value::Struct(Box::new(Struct {
        name: Cow::Borrowed("Foo"),
        data: Data::Struct {
            fields: vec![(Cow::Borrowed("bar"), Value::Bool(true))],
        },
    }));
    assert_eq!(value, expected);
}

#[test]
fn untagged() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    #[serde(untagged)]
    enum Foo {
        Bar(usize),
    }

    let bar = 56;
    let foo = Foo::Bar(bar);

    let value = Serializer::new().serialize(&foo).unwrap();
    let deserializer = Deserializer::new(value);
    assert_eq!(foo, deserializer.clone().deserialize().unwrap());
    assert_eq!(bar, deserializer.deserialize().unwrap());
}
