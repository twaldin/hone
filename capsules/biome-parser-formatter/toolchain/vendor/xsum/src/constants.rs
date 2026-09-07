// CONSTANTS DEFINING THE FLOATING POINT FORMAT
pub(crate) const XSUM_MANTISSA_BITS: i64 = 52; // Bits in fp mantissa, excludes implict 1
pub(crate) const XSUM_EXP_BITS: i64 = 11; // Bits in fp exponent
pub(crate) const XSUM_MANTISSA_MASK: i64 = (1i64 << XSUM_MANTISSA_BITS) - 1; // Mask for mantissa bits
pub(crate) const XSUM_EXP_MASK: i64 = (1 << XSUM_EXP_BITS) - 1; // Mask for exponent
pub(crate) const XSUM_EXP_BIAS: i64 = (1 << (XSUM_EXP_BITS - 1)) - 1; // Bias added to signed exponent
pub(crate) const XSUM_SIGN_BIT: i64 = XSUM_MANTISSA_BITS + XSUM_EXP_BITS; // Position of sign bit
pub(crate) const XSUM_SIGN_MASK: i64 = 1i64 << XSUM_SIGN_BIT; // Mask for sign bit

// CONSTANTS DEFINING THE SMALL ACCUMULATOR FORMAT
pub(crate) const XSUM_SCHUNK_BITS: i64 = 64; // Bits in chunk of the small accumulator
pub(crate) const XSUM_LOW_EXP_BITS: i64 = 5; // # of low bits of exponent, in one chunk
pub(crate) const XSUM_LOW_EXP_MASK: i64 = (1 << XSUM_LOW_EXP_BITS) - 1; // Mask for low-order exponent bits
pub(crate) const XSUM_HIGH_EXP_BITS: i64 = XSUM_EXP_BITS - XSUM_LOW_EXP_BITS; // # of high exponent bits for index
pub(crate) const XSUM_SCHUNKS: i32 = (1 << XSUM_HIGH_EXP_BITS) + 3; // # of chunks in small accumulator
pub(crate) const XSUM_LOW_MANTISSA_BITS: i64 = 1 << XSUM_LOW_EXP_BITS; // Bits in low part of mantissa
pub(crate) const XSUM_LOW_MANTISSA_MASK: i64 = (1i64 << XSUM_LOW_MANTISSA_BITS) - 1; // Mask for low bits
pub(crate) const XSUM_SMALL_CARRY_BITS: i64 = (XSUM_SCHUNK_BITS - 1) - XSUM_MANTISSA_BITS; // Bits sums can carry into
pub(crate) const XSUM_SMALL_CARRY_TERMS: i64 = (1 << XSUM_SMALL_CARRY_BITS) - 1; // # terms can add before need prop.

// CONSTANTS DEFINING THE LARGE ACCUMULATOR FORMAT
pub(crate) const XSUM_LCOUNT_BITS: i64 = 64 - XSUM_MANTISSA_BITS; // # of bits in count
pub(crate) const XSUM_LCHUNKS: usize = 1 << (XSUM_EXP_BITS + 1); // # of chunks in large accumulator

// Misc

/// The `XSUM_THRESHOLD` is used to determine whether an xsum is small or large, based on the number of inputs.
/// This is the default value, but you may use a different value if it works better.
pub const XSUM_THRESHOLD: usize = 1_000;
