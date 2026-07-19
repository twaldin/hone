# Precomputed Map

Precomputed a Map to embed in binary.

## What and Why

The tool attempts to achieve the best in terms of
runtime performance (include startup time and single query time), product size, and compilation speed.
and avoid any heavyweight dependency libraries and unsafe code,
make it possible to be used without supply chain burden.

Under the hood, we use binary search or phf for different sizes of data.
For small data, the runtime performance should be faster than a typical hashmap, and there is almost no size overhead.
For large data, it only requires one additional memory access at runtime, and only 1 byte of size overhead for every 3 entries.

At same time, in order to ensure the compilation speed,
the tool supports packaging a large number of strings into a single blob.
this will greatly improve the compilation performance and product size.

When there are 200,000 entries, the demo has the following comparison data:

|                            | startup | single query    | compile | size (stripped)
|----------------------------|---------|-----------------|---------|----------------
|naive (fold)                | 3.6ms   | 25ns / 104cycle | 6.9s    | 14M
|precomputed (fold/position) | _       | 23ns / 86cycle  | 0.3s    | 6.3M

* Data from my Arch Linux (intel ultra 7 258V)

## Usage

For small amounts of data, it is suitable to be executed in `build.rs`.
For large amounts of data, it is better to have a separate xtask stage
to generate code without affecting development performance.

```rust
fn build(keys: &[&str], values: &[&str]) {
    // compute map
    let mapout = precomputed_map::builder::MapBuilder::<&str>::new()
        .set_seed(prev_seed)
        .set_ord(&|x, y| x.cmp(y))
        .set_hash(&|seed, &k| {
            let mut hasher = MyHasher::with_key(seed);
            k.hash(&mut hasher);
            k.finish()
        })
        .build(&keys)
        .unwrap();

    let dir = PathBuf::from("src/generated");

    // remove old file
    let _ = fs::remove_file(dir.join("mymap.u8"));
    let _ = fs::remove_file(dir.join("mymap.u32"));

    let mut u8seq = U32SeqWriter::new("PrecomputedU8".into(), dir.join("mymap.u8"));
    let mut u32seq = U32SeqWriter::new("PrecomputedU32".into(), dir.join("mymap.u32"));

    // generate code
    let mut builder = precomputed_map::builder::CodeBuilder::new(
        "MyMap".into(),
        "MyHasher".into(),
        &mut u8seq,
        &mut u32seq,
    );

    let kseq = mapout.reorder(keys).map(|s| s.as_bytes());
    let vseq = mapout.reorder(values).map(|s| s.as_bytes());
    let k = builder.create_bytes_keys("MyKeys".into(), &mapout, kseq).unwrap();
    let v = builder.create_bytes_position_seq("MyValues".into(), vseq).unwrap();
    let pair = builder.create_pair(k, v);

    mapout.create_map("MYMAP".into(), pair, &mut builder).unwrap();

    let mut codeout = fs::File::create(dir.join("mymap.rs")).unwrap();
    builder.codegen(&mut codeout).unwrap();
    u8seq.codegen(&mut code_file).unwrap();
    u32seq.codegen(&mut code_file).unwrap();

    // ...
}
```

# License

This project is licensed under the MIT license.
