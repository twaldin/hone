# Xsum in Rust

This crate implments xsum algorithm by Radford M. Neal (https://arxiv.org/abs/1505.05571).

xsum is able to calculate fast exact summation.

> [!NOTE]
> ⚠️ Currently, xsum supports `f64` calculation only.

## Xsum Types

- `XsumSmall`: Optimized for vectors or arrays with up to 1,000 elements.
- `XsumLarge`: Optimized for vectors or arrays with more than 1,000 elements.
- `XsumAuto`: Automatically selects the appropriate variant when the vectors or array size is unknown.
- `XsumVariant`: Provides a convenient interface for managing multiple Xsum structs.

> [!TIP]
>
> `XsumAuto` internally uses `XsumSmall` and `XsumLarge`.
> `XsumAuto` has runtime overhead to determine when to switch from `XsumSmall` to `XsumLarge`.
> If you already know the input size in advance, consider using `XsumVariant` instead to avoid this overhead.

## Usage

### `add_list()` to take vector or array

Calculates the sum of a small-sized vector or array.

```rs
use xsum::{Xsum, XsumSmall};

let mut xsmall = XsumSmall::new();
xsmall.add_list(&vec![1.0, 2.0, 3.0]);
assert_eq!(xsmall.sum(), 6.0);
```

Calculates the sum of a large-sized vector or array (more than 1,000 elements).

```rs
use xsum::{Xsum, XsumLarge};

let mut xlarge = XsumLarge::new();
xlarge.add_list(&vec![1.0; 1_000]);
assert_eq!(xlarge.sum(), 1000.0);
```

Calculates the sum of a unknown-sized vector or array.

```rs
use xsum::{Xsum, XsumAuto};

let mut xauto = XsumAuto::new();
xauto.add_list(&vec![1.0; 1_000]);
assert_eq!(xauto.sum(), 1000.0);
```

### `add()` to take a floating point number

```rs
use xsum::{Xsum, XsumSmall};

let mut xsmall = XsumSmall::new();
let vec = vec![1.0, 2.0, 3.0];
for v in vec {
    xsmall.add(v);
}
assert_eq!(xsmall.sum(), 6.0);
```

### Chaining Method

```rs
use xsum::{Xsum, XsumExt};

let vec = vec![1.0, 2.0, 3.0];
assert_eq!(vec.xsum(), 6.0);
```

### Variant

If you already know the input size in advance, you can directly select the
most suitable xsum variant, avoiding unnecessary overhead.

```rs
use xsum::{Xsum, XsumVariant, XsumAuto, XsumLarge, XsumSmall, constants::XSUM_THRESHOLD};

let vec = vec![1.0; 2_000];
let mut xVariant = if vec.len() < XSUM_THRESHOLD {
  XsumVariant::Small(XsumSmall::new())
} else {
  XsumVariant::Large(XsumLarge::new())
};
xVariant.add_list(&vec);
assert_eq!(xVariant.sum(), 2_000.0);
```

## Comformance

xsum comforms to Javascript's [Math.sumPrecise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/sumPrecise) behavior.

## Safety

This crate sets `unsafe_code = "forbid"` in `Cargo.toml` to ensure that only safe Rust is used.

## Documentation

The doc can be found on [docs.rs](https://docs.rs/xsum/).
