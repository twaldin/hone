#![cfg(all(
    not(feature = "big_endian"),
    not(feature = "pointer_width_16"),
    not(feature = "pointer_width_64"),
    not(feature = "unaligned"),
    feature = "std",
    feature = "bytecheck",
))]

use std::collections::HashMap;

use rkyv::{from_bytes, rancor::Error, Archive, Deserialize, Serialize};

macro_rules! fuzz_target {
    ($name:ident as $ty:ty) => {
        #[test]
        fn $name() {
            let data =
                include_bytes!(concat!("fuzz/", stringify!($name), ".bin"));
            let _ = from_bytes::<$ty, Error>(data);
        }
    };
}

fuzz_target!(hashmap_string_oob_read as HashMap<String, Vec<u32>>);
fuzz_target!(hashmap_simd_oob_read as HashMap<String, Vec<u32>>);
fuzz_target!(hashmap_u64_bytes_oob as HashMap<u64, Vec<u8>>);

#[derive(Archive, Deserialize, Serialize)]
struct ComplexBag {
    names: Vec<String>,
    counters: Option<HashMap<String, u32>>,
    payload: Box<Vec<u64>>,
    flag: bool,
}

fuzz_target!(complex_struct_uaf as ComplexBag);

fuzz_target!(swiss_table_unchecked_assert as HashMap<String, String>);

fuzz_target!(
    hashmap_archivedstring_deserialize_segv as HashMap<String, String>
);
fuzz_target!(
    hashmap_archivedstring_deserialize_segv_alt_vec_wrapper
        as Vec<HashMap<String, String>>
);
