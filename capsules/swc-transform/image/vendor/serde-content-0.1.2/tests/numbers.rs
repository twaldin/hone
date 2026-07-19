#![cfg(feature = "derive")]

extern crate alloc;

use core::fmt;
use serde::Deserialize;
use serde_content::Deserializer;
use serde_content::Error;
use serde_content::Expected;
use serde_content::Found;
use serde_content::Number;
use serde_content::Serializer;

fn assert_ok<T>(deserializer: Deserializer<'static>)
where
    T: Deserialize<'static> + Into<Number> + fmt::Debug,
{
    deserializer.deserialize::<T>().unwrap();
}

fn assert_err<T>(deserializer: Deserializer<'static>, found: Found, expected: Expected)
where
    T: Deserialize<'static> + fmt::Debug,
{
    let error = deserializer.deserialize::<T>().unwrap_err();
    let expected = Error::unexpected(found, expected);
    assert_eq!(error, expected);
}

macro_rules! range {
    ($src:ident as $dest:ty) => {
        (($src::MIN as $dest)..=($src::MAX as $dest))
    };
}

#[test]
fn coerce_i8() {
    let serializer = Serializer::new();
    for v in [i8::MIN, 0, i8::MAX] {
        let value = serializer.serialize(v).unwrap();
        let deserializer = Deserializer::new(value);
        // Conversion between different number types is not supported by default.
        assert_err::<u8>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::U8,
        );
        assert_err::<i16>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::I16,
        );
        assert_err::<u16>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::U16,
        );
        assert_err::<i32>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::I32,
        );
        assert_err::<f32>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::F32,
        );
        assert_err::<u32>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::U32,
        );
        assert_err::<i64>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::I64,
        );
        assert_err::<f64>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::F64,
        );
        assert_err::<u64>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::U64,
        );
        assert_err::<i128>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::I128,
        );
        assert_err::<u128>(
            deserializer.clone(),
            Found::Number(Number::I8(v)),
            Expected::U128,
        );
        // Enable number coercion.
        let deserializer = deserializer.coerce_numbers();
        assert_ok::<i16>(deserializer.clone());
        assert_ok::<i32>(deserializer.clone());
        assert_ok::<f32>(deserializer.clone());
        assert_ok::<i64>(deserializer.clone());
        assert_ok::<f64>(deserializer.clone());
        assert_ok::<i128>(deserializer.clone());
        if v < 0 {
            assert_err::<u8>(
                deserializer.clone(),
                Found::Number(Number::I8(v)),
                Expected::U8,
            );
            assert_err::<u16>(
                deserializer.clone(),
                Found::Number(Number::I8(v)),
                Expected::U16,
            );
            assert_err::<u32>(
                deserializer.clone(),
                Found::Number(Number::I8(v)),
                Expected::U32,
            );
            assert_err::<u64>(
                deserializer.clone(),
                Found::Number(Number::I8(v)),
                Expected::U64,
            );
            assert_err::<u128>(
                deserializer.clone(),
                Found::Number(Number::I8(v)),
                Expected::U128,
            );
            assert_err::<u128>(deserializer, Found::Number(Number::I8(v)), Expected::U128);
        } else {
            assert_ok::<u8>(deserializer.clone());
            assert_ok::<u16>(deserializer.clone());
            assert_ok::<u32>(deserializer.clone());
            assert_ok::<u64>(deserializer.clone());
            assert_ok::<u128>(deserializer);
        }
    }
}

#[test]
fn coerce_u8() {
    let serializer = Serializer::new();
    for v in [u8::MIN, 0, u8::MAX] {
        let value = serializer.serialize(v).unwrap();
        let deserializer = Deserializer::new(value);
        assert_err::<i8>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::I8,
        );
        assert_err::<i16>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::I16,
        );
        assert_err::<u16>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::U16,
        );
        assert_err::<i32>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::I32,
        );
        assert_err::<f32>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::F32,
        );
        assert_err::<u32>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::U32,
        );
        assert_err::<i64>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::I64,
        );
        assert_err::<i64>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::I64,
        );
        assert_err::<f64>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::F64,
        );
        assert_err::<u64>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::U64,
        );
        assert_err::<i128>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::I128,
        );
        assert_err::<u128>(
            deserializer.clone(),
            Found::Number(Number::U8(v)),
            Expected::U128,
        );
        let deserializer = deserializer.coerce_numbers();
        if v <= (i8::MAX as u8) {
            assert_ok::<i8>(deserializer.clone());
        } else {
            assert_err::<i8>(
                deserializer.clone(),
                Found::Number(Number::U8(v)),
                Expected::I8,
            );
        }
        assert_ok::<i16>(deserializer.clone());
        assert_ok::<u16>(deserializer.clone());
        assert_ok::<i32>(deserializer.clone());
        assert_ok::<f32>(deserializer.clone());
        assert_ok::<u32>(deserializer.clone());
        assert_ok::<i64>(deserializer.clone());
        assert_ok::<f64>(deserializer.clone());
        assert_ok::<u64>(deserializer.clone());
        assert_ok::<i128>(deserializer.clone());
        assert_ok::<u128>(deserializer);
    }
}

#[test]
fn coerce_i16() {
    let serializer = Serializer::new();
    for v in [i16::MIN, 0, i16::MAX] {
        let value = serializer.serialize(v).unwrap();
        let deserializer = Deserializer::new(value);
        assert_err::<i8>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::I8,
        );
        assert_err::<u8>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::U8,
        );
        assert_err::<u16>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::U16,
        );
        assert_err::<i32>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::I32,
        );
        assert_err::<f32>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::F32,
        );
        assert_err::<u32>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::U32,
        );
        assert_err::<i64>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::I64,
        );
        assert_err::<f64>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::F64,
        );
        assert_err::<u64>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::U64,
        );
        assert_err::<i128>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::I128,
        );
        assert_err::<u128>(
            deserializer.clone(),
            Found::Number(Number::I16(v)),
            Expected::U128,
        );
        let deserializer = deserializer.coerce_numbers();
        if range!(i8 as i16).contains(&v) {
            assert_ok::<i8>(deserializer.clone());
        } else {
            assert_err::<i8>(
                deserializer.clone(),
                Found::Number(Number::I16(v)),
                Expected::I8,
            );
        }
        if range!(u8 as i16).contains(&v) {
            assert_ok::<u8>(deserializer.clone());
        } else {
            assert_err::<u8>(
                deserializer.clone(),
                Found::Number(Number::I16(v)),
                Expected::U8,
            );
        }
        assert_ok::<i32>(deserializer.clone());
        assert_ok::<f32>(deserializer.clone());
        assert_ok::<i64>(deserializer.clone());
        assert_ok::<f64>(deserializer.clone());
        assert_ok::<i128>(deserializer.clone());
        if v < 0 {
            assert_err::<u16>(
                deserializer.clone(),
                Found::Number(Number::I16(v)),
                Expected::U16,
            );
            assert_err::<u32>(
                deserializer.clone(),
                Found::Number(Number::I16(v)),
                Expected::U32,
            );
            assert_err::<u64>(
                deserializer.clone(),
                Found::Number(Number::I16(v)),
                Expected::U64,
            );
            assert_err::<u128>(deserializer, Found::Number(Number::I16(v)), Expected::U128);
        } else {
            assert_ok::<u16>(deserializer.clone());
            assert_ok::<u32>(deserializer.clone());
            assert_ok::<u64>(deserializer.clone());
            assert_ok::<u128>(deserializer);
        }
    }
}

#[test]
fn coerce_f32() {
    let serializer = Serializer::new();
    for v in [f32::MIN, 0.0, f32::MAX] {
        let value = serializer.serialize(v).unwrap();
        let deserializer = Deserializer::new(value);
        assert_err::<f64>(
            deserializer.clone(),
            Found::Number(Number::F32(v)),
            Expected::F64,
        );
        let deserializer = deserializer.coerce_numbers();
        assert_ok::<f64>(deserializer);
    }
}

#[test]
fn coerce_f64() {
    let serializer = Serializer::new();
    for v in [f64::MIN, 0.0, f64::MAX] {
        let value = serializer.serialize(v).unwrap();
        let deserializer = Deserializer::new(value);
        assert_err::<f32>(
            deserializer.clone(),
            Found::Number(Number::F64(v)),
            Expected::F32,
        );
        let deserializer = deserializer.coerce_numbers();
        if range!(f32 as f64).contains(&v) {
            assert_ok::<f32>(deserializer.clone());
        } else {
            assert_err::<f32>(
                deserializer.clone(),
                Found::Number(Number::F64(v)),
                Expected::F32,
            );
        }
    }
}
