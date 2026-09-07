use crate::{
    accumulators::small_accumulator::SmallAccumulator,
    constants::{
        XSUM_EXP_BIAS, XSUM_EXP_MASK, XSUM_LOW_EXP_BITS, XSUM_LOW_MANTISSA_BITS,
        XSUM_MANTISSA_BITS, XSUM_MANTISSA_MASK, XSUM_SIGN_MASK,
    },
    Xsum,
};

/// XsumSmall is efficient when vector or array size is less than or equal to 1,000
///
/// # Example
///
/// ```
/// use xsum::{Xsum, XsumExt};
///
/// let vec = vec![1.0, 2.0, 3.0];
/// assert_eq!(vec.xsum(), 6.0);
/// ```
#[cfg_attr(debug_assertions, derive(Debug))]
pub struct XsumSmall {
    m_sacc: SmallAccumulator,
}

impl Default for XsumSmall {
    fn default() -> Self {
        Self::new()
    }
}

impl XsumSmall {
    pub(crate) fn new_with(small_accumulator: &SmallAccumulator) -> Self {
        Self {
            m_sacc: SmallAccumulator::new_based_on(
                &small_accumulator.m_chunk,
                small_accumulator.m_adds_until_propagate,
                small_accumulator.m_inf,
                small_accumulator.m_nan,
                small_accumulator.m_size_count,
                small_accumulator.m_has_pos_number,
            ),
        }
    }

    #[inline(always)]
    pub(crate) const fn get_size_count(&self) -> usize {
        self.m_sacc.m_size_count
    }

    #[inline(always)]
    pub(crate) fn transfer_accumulator(self) -> SmallAccumulator {
        self.m_sacc
    }
}

impl Xsum for XsumSmall {
    fn new() -> Self {
        Self {
            m_sacc: SmallAccumulator::new(),
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumSmall};
    ///
    /// let mut xsmall = XsumSmall::new();
    /// xsmall.add_list(&vec![1.0, 2.0, 3.0]);
    /// assert_eq!(xsmall.sum(), 6.0);
    /// ```
    fn add_list(&mut self, vec: &[f64]) {
        let mut offset: usize = 0;
        let mut n: usize = vec.len();

        while 0 < n {
            if self.m_sacc.m_adds_until_propagate == 0 {
                self.m_sacc.carry_propagate();
            }
            let m: usize = std::cmp::min(n, self.m_sacc.m_adds_until_propagate as usize);
            for &value in &vec[offset..offset + m] {
                self.m_sacc.increment_when_value_added(value);
                self.m_sacc.add1_no_carry(value);
            }
            self.m_sacc.m_adds_until_propagate -= m as i64;
            offset += m;
            n -= m;
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumSmall};
    ///
    /// let mut xsmall = XsumSmall::new();
    /// let vec = vec![1.0, 2.0, 3.0];
    /// for v in vec {
    ///     xsmall.add(v);
    /// }
    /// assert_eq!(xsmall.sum(), 6.0);
    /// ```
    #[inline(always)]
    fn add(&mut self, value: f64) {
        self.m_sacc.increment_when_value_added(value);
        if self.m_sacc.m_adds_until_propagate == 0 {
            self.m_sacc.carry_propagate();
        }
        self.m_sacc.add1_no_carry(value);
        self.m_sacc.m_adds_until_propagate -= 1;
    }

    /// ```
    /// use xsum::{Xsum, XsumSmall};
    ///
    /// let mut xsmall = XsumSmall::new();
    /// xsmall.add_list(&vec![1.0, 2.0, 3.0]);
    /// assert_eq!(xsmall.sum(), 6.0);
    /// ```
    fn sum(&mut self) -> f64 {
        // See if we have a NaN from one of the numbers being a NaN, in
        // which case we return the NaN with largest payload, or an infinite
        // result (+Inf, -Inf, or a NaN if both +Inf and -Inf occurred).
        // Note that we do NOT return NaN if we have both an infinite number
        // and a sum of other numbers that overflows with opposite sign,
        // since there is no real ambiguity regarding the sign in such a case.

        if self.m_sacc.m_nan != 0 {
            return f64::from_bits(self.m_sacc.m_nan as u64);
        }

        if self.m_sacc.m_inf != 0 {
            return f64::from_bits(self.m_sacc.m_inf as u64);
        }

        if self.m_sacc.m_size_count == 0 {
            return -0.0;
        }

        // If none of the numbers summed were infinite or NaN, we proceed to
        // propagate carries, as a preliminary to finding the magnitude of
        // the sum.  This also ensures that the sign of the result can be
        // determined from the uppermost non-zero chunk.

        // We also find the index, i, of this uppermost non-zero chunk, as
        // the value returned by carryPropagate, and set ivalue to
        // m_sacc.chunk[i].  Note that ivalue will not be 0 or -1, unless
        // i is 0 (the lowest chunk), in which case it will be handled by
        // the code for denormalized numbers.
        let i: i32 = self.m_sacc.carry_propagate();
        let mut ivalue: i64 = self.m_sacc.m_chunk[i as usize];
        let mut intv: i64;

        // Handle a possible denormalized number, including zero.
        if i <= 1 {
            // Check for zero value, in which case we can return immediately.
            if ivalue == 0 {
                return if !self.m_sacc.m_has_pos_number {
                    -0.0
                } else {
                    0.0
                };
            }

            // Check if it is actually a denormalized number.  It always is if only
            // the lowest chunk is non-zero.  If the highest non-zero chunk is the
            // next-to-lowest, we check the magnitude of the absolute value.
            // Note that the real exponent is 1 (not 0), so we need to shift right
            // by 1 here.
            if i == 0 {
                intv = ivalue.abs();
                intv >>= 1;
                if ivalue < 0 {
                    intv |= XSUM_SIGN_MASK;
                }
                return f64::from_bits(intv as u64);
            } else {
                // Note: Left shift of -ve number is undefined, so do a multiply instead,
                // which is probably optimized to a shift.
                let mut intv: i64 =
                    ivalue * (1i64 << (XSUM_LOW_MANTISSA_BITS - 1)) + (self.m_sacc.m_chunk[0] >> 1);
                if intv < 0 {
                    if intv > -(1i64 << XSUM_MANTISSA_BITS) {
                        intv = (-intv) | XSUM_SIGN_MASK;
                        return f64::from_bits(intv as u64);
                    }
                } else {
                    // non-negative
                    if (intv as u64) < 1u64 << XSUM_MANTISSA_BITS {
                        return f64::from_bits(intv as u64);
                    }
                }
                // otherwise, it's not actually denormalized, so fall through to below
            }
        }

        // Find the location of the uppermost 1 bit in the absolute value of
        // the upper chunk by converting it (as a signed integer) to a
        // floating point value, and looking at the exponent.  Then set
        // 'more' to the number of bits from the lower chunk (and maybe the
        // next lower) that are needed to fill out the mantissa of the
        // result (including the top implicit 1 bit), plus two extra bits to
        // help decide on rounding.  For negative numbers, it may turn out
        // later that we need another bit, because negating a negative value
        // may carry out of the top here, but not carry out of the top once
        // more bits are shifted into the bottom later on.

        let fltv: f64 = ivalue as f64; // finds position of topmost 1 bit of |ivalue|
        intv = fltv.to_bits() as i64;
        let mut e: i32 = ((intv >> XSUM_MANTISSA_BITS) & XSUM_EXP_MASK) as i32; // e-bias is in 0..32
        let mut more: i32 = (2 + XSUM_MANTISSA_BITS + XSUM_EXP_BIAS - e as i64) as i32;

        // Change 'ivalue' to put in 'more' bits from lower chunks into the bottom.
        // Also set 'j' to the index of the lowest chunk from which these bits came,
        // and 'lower' to the remaining bits of that chunk not now in 'ivalue'.
        // Note that 'lower' initially has at least one bit in it, which we can
        // later move into 'ivalue' if it turns out that one more bit is needed.

        ivalue *= 1i64 << more; // multiply, since << of negative undefined
        let mut j: i32 = i - 1;
        let mut lower: i64 = self.m_sacc.m_chunk[j as usize]; // must exist, since denormalized if i==0
        if more >= XSUM_LOW_MANTISSA_BITS as i32 {
            more -= XSUM_LOW_MANTISSA_BITS as i32;
            ivalue += lower << more;
            j -= 1;
            lower = if j < 0 {
                0
            } else {
                self.m_sacc.m_chunk[j as usize]
            };
        }
        ivalue += lower >> (XSUM_LOW_MANTISSA_BITS - more as i64);
        lower &= (1i64 << (XSUM_LOW_MANTISSA_BITS - more as i64)) - 1;

        // Decide on rounding, with separate code for positive and negative values.
        // At this point, 'ivalue' has the signed mantissa bits, plus two extra
        // bits, with 'e' recording the exponent position for these within their
        // top chunk.  For positive 'ivalue', the bits in 'lower' and chunks
        // below 'j' add to the absolute value; for negative 'ivalue' they
        // subtract.
        // After setting 'ivalue' to the tentative unsigned mantissa
        // (shifted left 2), and 'intv' to have the correct sign, this
        // code goes to done_rounding if it finds that just discarding lower
        // order bits is correct, and to round_away_from_zero if instead the
        // magnitude should be increased by one in the lowest mantissa bit.
        let mut should_round_away_from_zero: bool = false;
        if 0 <= ivalue {
            // number is positive, lower bits are added to magnitude
            intv = 0; // positive sign

            if (ivalue & 2) == 0 {
                // extra bits are 0x
                // TODO: this is not required,
                // but removing the branch would change the logic
                should_round_away_from_zero = false;
            } else if (ivalue & 1) != 0 {
                // extra bits are 11
                should_round_away_from_zero = true;
            } else if (ivalue & 4) != 0 {
                // low bit is 1 (odd), extra bits are 10
                should_round_away_from_zero = true;
            } else {
                if lower == 0 {
                    // see if any lower bits are non-zero
                    while j > 0 {
                        j -= 1;
                        if self.m_sacc.m_chunk[j as usize] != 0 {
                            lower = 1;
                            break;
                        }
                    }
                }
                if lower != 0 {
                    // low bit 0 (even), extra bits 10, non-zero lower bits
                    should_round_away_from_zero = true;
                }
            }
        } else {
            // number is negative, lower bits are subtracted from magnitude
            // Check for a negative 'ivalue' that when negated doesn't contain a full
            // mantissa's worth of bits, plus one to help rounding.  If so, move one
            // more bit into 'ivalue' from 'lower' (and remove it from 'lower').
            // This happens when the negation of the upper part of 'ivalue' has the
            // form 10000... but the negation of the full 'ivalue' is not 10000...

            if ((-ivalue) & (1i64 << (XSUM_MANTISSA_BITS + 2))) == 0 {
                let pos: i32 = (1i64 << (XSUM_LOW_MANTISSA_BITS - 1i64 - more as i64)) as i32;
                ivalue *= 2; // note that left shift undefined if ivalue is negative
                if lower & pos as i64 != 0 {
                    ivalue += 1;
                    lower &= !pos as i64;
                }
                e -= 1;
            }

            intv = XSUM_SIGN_MASK; // negative sign
            ivalue = -ivalue; // ivalue now contains the absolute value

            if (ivalue & 3) == 3 {
                // extra bits are 11
                should_round_away_from_zero = true;
            }

            if lower == 0 {
                // see if any lower bits are non-zero
                while j > 0 {
                    j -= 1;
                    if self.m_sacc.m_chunk[j as usize] != 0 {
                        lower = 1;
                        break;
                    }
                }
            }

            if lower == 0 {
                // low bit 1 (odd), extra bits are 10, lower bits are all 0
                should_round_away_from_zero = true;
            }
        }

        if should_round_away_from_zero {
            // Round away from zero, then check for carry having propagated out the
            // top, and shift if so.
            ivalue += 4; // add 1 to low-order mantissa bit
            if ivalue & (1i64 << (XSUM_MANTISSA_BITS + 3)) != 0 {
                ivalue >>= 1;
                e += 1;
            }
        }

        // Get rid of the bottom 2 bits that were used to decide on rounding.
        ivalue >>= 2;

        // Adjust to the true exponent, accounting for where this chunk is.
        e += (i << XSUM_LOW_EXP_BITS) - XSUM_EXP_BIAS as i32 - XSUM_MANTISSA_BITS as i32;

        // If exponent has overflowed, change to plus or minus Inf and return.
        if e >= XSUM_EXP_MASK as i32 {
            intv |= XSUM_EXP_MASK << XSUM_MANTISSA_BITS;
            return f64::from_bits(intv as u64);
        }

        // Put exponent and mantissa into intv, which already has the sign,
        // then copy into fltv.

        intv += (e as i64) << XSUM_MANTISSA_BITS;
        intv += ivalue & XSUM_MANTISSA_MASK; // mask out the implicit 1 bit
        f64::from_bits(intv as u64)
    }

    /// ```
    /// use xsum::{Xsum, XsumSmall};
    ///
    /// let mut xsmall = XsumSmall::new();
    /// xsmall.add_list(&vec![1.0; 10]);
    /// assert_eq!(xsmall.sum(), 10.0);
    ///
    /// xsmall.clear();
    /// let res = xsmall.sum(); // -0.0
    /// assert_eq!(res, -0.0);
    /// assert!(res.is_sign_negative());
    /// ```
    #[inline(always)]
    fn clear(&mut self) {
        *self = Self::default();
    }
}
