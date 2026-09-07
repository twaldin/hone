//! Benchmark `unescape` functions with [`criterion`].

#![allow(clippy::missing_docs_in_private_items, missing_docs)]

use criterion::{
    criterion_group, criterion_main, BenchmarkId, Criterion, Throughput,
};
#[allow(clippy::wildcard_imports)]
use htmlize::*;
use std::time::Duration;

#[macro_use]
mod util;

fn benchmarks(c: &mut Criterion) {
    let mut group = c.benchmark_group("unescape");
    group
        .noise_threshold(0.10)
        .significance_level(0.01)
        .confidence_level(0.99)
        .sample_size(300)
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(10));

    let test_inputs = [
        ("normal", "&lt;"),
        ("bare", "&lta"),
        ("none", "_lta"),
        ("invalid", "&xxa"),
    ];

    for (name, entity) in test_inputs {
        let name = format!("sample_128_{name}");
        let input = util::inputs::make_sample(128, entity, "a");

        #[cfg(feature = "unescape")]
        util::benchmark!(group, unescape_slow, &name, &input);
        #[cfg(feature = "unescape")]
        util::benchmark!(group, unescape_attribute_slow, &name, &input);

        #[cfg(feature = "unescape_fast")]
        util::benchmark!(group, unescape_fast, &name, &input);
        #[cfg(feature = "unescape_fast")]
        util::benchmark!(group, unescape_attribute_fast, &name, &input);
    }

    group.finish();
}

criterion_group!(unescape_group, benchmarks);
criterion_main!(unescape_group);
