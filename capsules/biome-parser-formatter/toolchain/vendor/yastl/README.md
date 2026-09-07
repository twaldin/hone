`yastl`
=======

[![Crates.io](https://img.shields.io/crates/v/yastl.svg)](https://crates.io/crates/yastl)
[![Documentation](https://img.shields.io/badge/documentation-docs.rs-blue.svg)](https://docs.rs/yastl)

**Yet another scoped threadpool library for Rust.**

`yastl` is heavily inspired by the [`scoped_threadpool`][scoped_threadpool] and
[`scoped_pool`][scoped_pool] crates. It is mostly a port to modern Rust of the
[`scoped_pool`][scoped_pool] crate


## Example

```rust
use yastl::Pool;

fn main() {
    let pool = Pool::new(4);
    let mut list = vec![1, 2, 3, 4, 5];

    pool.scoped(|scope| {
        // since the `scope` guarantees that the threads are finished if it drops,
        // we can safely borrow `list` inside here.
        for x in list.iter_mut() {
            scope.execute(move || {
                *x += 2;
            });
        }
    });

    assert_eq!(list, vec![3, 4, 5, 6, 7]);
}
```

## Feature Flags

- `coz`: Enable support for the [`coz`](https://github.com/plasma-umass/coz) profiler.
  Calls `coz::thread_init()` in every new thread.

### License

Licensed under the [MIT][mit] license.


[scoped_threadpool]: https://crates.io/crates/scoped_threadpool
[scoped_pool]: https://crates.io/crates/scoped_pool
[mit]: https://github.com/Stupremee/yastl/tree/main/LICENSE
