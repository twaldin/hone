// rustc doesn’t seem to realize these are used
#![allow(unused_imports, unused_macros)]

pub mod inputs;

macro_rules! benchmark {
    ( $group:expr, $function:ident, $size_name:expr, $input:expr ) => {{
        let input = $input;
        $group.throughput(Throughput::Bytes(input.len().try_into().unwrap()));
        $group.bench_with_input(
            BenchmarkId::new(stringify!($function), $size_name),
            input,
            |b, input| b.iter(|| $function(&*input)),
        );
    }};
}

pub(crate) use benchmark;
