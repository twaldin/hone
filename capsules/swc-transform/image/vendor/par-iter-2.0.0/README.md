# par-iter

A parallel iterator for Rust. This is a fork of `rayon` with the goal of switching parallelization library from `rayon-core` to `chili` or disable parallelization.
If you want to switch parallelization library, you can refer to the documentation of [`par-core`](https://docs.rs/par-core/).

## Usage

If you are using only parallel iterators, you can just replace all `rayon::` to `par_iter::` using IDE feature.

```rust
use par_iter::prelude::*;


```

# License

- This code is a fork of `rayon`. `rayon` is Apache-2.0/MIT licensed.

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.
