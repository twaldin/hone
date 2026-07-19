use std::fmt::Write;
use std::hash::{ Hash, Hasher };
use std::collections::hash_map::DefaultHasher;
use std::time::Instant;
use super::{ MapBuilder, MapKind };


#[test]
fn test_build_ptrhash() {
    let start = Instant::now();
    
    let n = 1024 * 1024;
    let (s, keys) = {
        let mut s = String::new();
        let mut keys = Vec::with_capacity(n);

        for i in 0..n {
            let start = s.len();
            write!(s, "{}", i).unwrap();
            keys.push(start..s.len());
        }

        (s, keys)
    };

    println!("start: {:?}", start.elapsed());

    let output = MapBuilder::<std::ops::Range<usize>>::new()
        .set_seed(3559301822128966697)
        .set_hash(&|key, v| {
            let mut hasher = DefaultHasher::new();
            hasher.write_u64(key);
            s[v.clone()].hash(&mut hasher);
            hasher.finish()
        })
        .set_next_seed(|key, c| {
            let mut hasher = DefaultHasher::new();
            hasher.write_u64(key);
            hasher.write_u64(c);
            hasher.finish()            
        })
        .build(&keys)
        .unwrap();

    println!("build done: {:?}", start.elapsed());

    if let MapKind::Medium { seed, .. } = &output.kind {
        assert_eq!(3559301822128966697, *seed);
    }
}
