use std::collections::HashMap;
use std::sync::LazyLock;

const fn generate_array<const N: usize>() -> [f64; N] {
    let mut arr = [0.0; N];
    let mut v = 0;
    while v < N {
        arr[v] = v as f64;
        v += 1;
    }
    arr
}

const ARRAY10: [f64; 10] = generate_array::<10>();
const ARRAY100: [f64; 100] = generate_array::<100>();
const ARRAY1000: [f64; 1_000] = generate_array::<1_000>();
const ARRAY5000: [f64; 5_000] = generate_array::<5_000>();
const ARRAY10000: [f64; 10_000] = generate_array::<10_000>();
const ARRAY20000: [f64; 20_000] = generate_array::<20_000>();
const ARRAY50000: [f64; 50_000] = generate_array::<50_000>();
const ARRAY100000: [f64; 100_000] = generate_array::<100_000>();

pub(crate) static DATA_MAP_F64: LazyLock<HashMap<usize, &'static [f64]>> = LazyLock::new(|| {
    HashMap::from([
        (10, ARRAY10.as_slice()),
        (100, ARRAY100.as_slice()),
        (1_000, ARRAY1000.as_slice()),
        (5_000, ARRAY5000.as_slice()),
        (10_000, ARRAY10000.as_slice()),
        (20_000, ARRAY20000.as_slice()),
        (50_000, ARRAY50000.as_slice()),
        (100_000, ARRAY100000.as_slice()),
    ])
});
