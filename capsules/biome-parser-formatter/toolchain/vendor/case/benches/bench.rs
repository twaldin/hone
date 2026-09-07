#![feature(test)]

extern crate case;
extern crate test;

use case::CaseExt;
use test::Bencher;

#[bench]
fn bench_to_camel(b: &mut Bencher) {
    b.iter(|| "my_favorite_string".to_camel());
}

#[bench]
fn bench_to_camel_lowercase(b: &mut Bencher) {
    b.iter(|| "my_favorite_string".to_camel_lowercase());
}

#[bench]
fn bench_to_snake(b: &mut Bencher) {
    b.iter(|| "MyFavoriteString".to_snake());
}

#[bench]
fn bench_to_dashed(b: &mut Bencher) {
    b.iter(|| "my_favorite_string".to_dashed());
}

#[bench]
fn bench_to_lowercase(b: &mut Bencher) {
    b.iter(|| CaseExt::to_lowercase("MY favorite STRING"));
}

#[bench]
fn bench_to_uppercase(b: &mut Bencher) {
    b.iter(|| CaseExt::to_uppercase("my_favorite_string"));
}

#[bench]
fn bench_to_capitalized(b: &mut Bencher) {
    b.iter(|| "my favorite string".to_capitalized());
}
