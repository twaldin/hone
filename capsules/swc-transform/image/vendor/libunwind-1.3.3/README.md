# libunwind
This library provides Rust bindings to the libunwind C library.

To use this library, you may have to modify your `Cargo.toml` file for cargo to link libunwind with your project:

```TOML
# other parts of Cargo.toml ...

[build]
rustflags = ["-C", "link-args=-lunwind"]
```