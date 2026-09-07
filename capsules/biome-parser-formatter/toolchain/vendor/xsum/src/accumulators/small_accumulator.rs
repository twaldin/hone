use crate::constants::{
    XSUM_EXP_MASK, XSUM_LOW_EXP_BITS, XSUM_LOW_EXP_MASK, XSUM_LOW_MANTISSA_BITS,
    XSUM_LOW_MANTISSA_MASK, XSUM_MANTISSA_BITS, XSUM_MANTISSA_MASK, XSUM_SCHUNKS, XSUM_SIGN_MASK,
    XSUM_SMALL_CARRY_TERMS,
};

#[cfg_attr(debug_assertions, derive(Debug))]
pub(crate) struct SmallAccumulator {
    pub(crate) m_chunk: Vec<i64>, // Chunks making up small accumulator
    pub(crate) m_adds_until_propagate: i64, // Number of remaining adds before carry
    pub(crate) m_inf: i64,        // If non-zero, +Inf, -Inf, or NaN
    pub(crate) m_nan: i64,        // If non-zero, a NaN value with payload
    pub(crate) m_size_count: usize, // number of added values
    pub(crate) m_has_pos_number: bool, // check if added values have at least one positive number
}

impl SmallAccumulator {
    pub(crate) fn new() -> Self {
        Self {
            m_chunk: vec![0; XSUM_SCHUNKS as usize],
            m_adds_until_propagate: XSUM_SMALL_CARRY_TERMS,
            m_inf: 0,
            m_nan: 0,
            m_size_count: 0,
            m_has_pos_number: false,
        }
    }

    pub(crate) fn new_based_on(
        chunk: &[i64],
        adds_until_propagate: i64,
        inf: i64,
        nan: i64,
        size_count: usize,
        has_pos_number: bool,
    ) -> Self {
        Self {
            m_chunk: chunk.to_owned(),
            m_adds_until_propagate: adds_until_propagate,
            m_inf: inf,
            m_nan: nan,
            m_size_count: size_count,
            m_has_pos_number: has_pos_number,
        }
    }

    pub(crate) fn carry_propagate(&mut self) -> i32 {
        // Set u to the index of the uppermost non-zero (for now) chunk, or
        // return with value 0 if there is none.
        let mut u: i32 = XSUM_SCHUNKS - 1;
        while 0 <= u && self.m_chunk[u as usize] == 0 {
            if u == 0 {
                self.m_adds_until_propagate = XSUM_SMALL_CARRY_TERMS - 1;
                return 0;
            }
            u -= 1;
        }

        // At this point, m_chunk[u] must be non-zero
        assert!(self.m_chunk[u as usize] != 0, "m_chunk[u] must be non-zero");

        // Carry propagate, starting at the low-order chunks.  Note that the
        // loop limit of u may be increased inside the loop.
        let mut i: i32 = 0; // set to the index of the next non-zero chunck, from bottom
        let mut uix: i32 = -1; // indicates that a non-zero chunk has not been found yet

        loop {
            let mut c: i64; // Set to the chunk at index i (next non-zero one)

            // Find the next non-zero chunk, setting i to its index, or break out
            // of loop if there is none.  Note that the chunk at index u is not
            // necessarily non-zero - it was initially, but u or the chunk at u
            // may have changed.
            loop {
                c = self.m_chunk[i as usize];
                if c != 0 {
                    break;
                }
                i += 1;
                if i > u {
                    break;
                }
            }

            if i > u {
                break;
            }

            let chigh: i64 = c >> XSUM_LOW_MANTISSA_BITS; // High-order bits of c
            if chigh == 0 {
                uix = i;
                i += 1;
                continue; // no need to change this chunk
            }

            if u == i {
                if chigh == -1 {
                    uix = i;
                    break; // don't propagate -1 into the region of all zeros above
                }
                u = i + 1; // we will change chunk[u+1], so we'll need to look at it
            }

            let clow: i64 = c & XSUM_LOW_MANTISSA_MASK; // Low-order bits of c
            if clow != 0 {
                uix = i;
            }

            // We now change chunk[i] and add to chunk[i+1]. Note that i+1 should be
            // in range (no bigger than XSUM_CHUNKS-1) if summing memory, since
            // the number of chunks is big enough to hold any sum, and we do not
            // store redundant chunks with values 0 or -1 above previously non-zero
            // chunks.  But other add operations might cause overflow, in which
            // case we produce a NaN with all 1s as payload.  (We can't reliably produce
            // an Inf of the right sign.)

            self.m_chunk[i as usize] = clow;
            if i + 1 >= XSUM_SCHUNKS {
                self.add_inf_nan((XSUM_EXP_MASK << XSUM_MANTISSA_BITS) | XSUM_MANTISSA_MASK);
                u = i;
            } else {
                self.m_chunk[(i + 1) as usize] += chigh; // note: this could make this chunk be zero
            }

            i += 1;

            if i > u {
                break;
            }
        }

        // Check again for the number being zero, since carry propagation might
        // have created zero from something that initially looked non-zero.
        if uix < 0 {
            uix = 0;
            self.m_adds_until_propagate = XSUM_SMALL_CARRY_TERMS - 1;
            return uix;
        }

        // While the uppermost chunk is negative, with value -1, combine it with
        // the chunk below (if there is one) to produce the same number but with
        // one fewer non-zero chunks.
        while self.m_chunk[uix as usize] == -1 && uix > 0 {
            // Left shift of a negative number is undefined according to the standard,
            // so do a multiply - it's all presumably constant-folded by the compiler.
            self.m_chunk[(uix - 1) as usize] += -((1i64) << XSUM_LOW_MANTISSA_BITS);
            self.m_chunk[uix as usize] = 0;
            uix -= 1;
        }

        self.m_adds_until_propagate = XSUM_SMALL_CARRY_TERMS - 1;
        uix // Return index of uppermost non-zero chunk
    }

    #[cold]
    pub(crate) fn add_inf_nan(&mut self, ivalue: i64) {
        let mantissa: i64 = ivalue & XSUM_MANTISSA_MASK;

        if mantissa == 0 {
            // Inf
            if self.m_inf == 0 {
                // no previous Inf
                self.m_inf = ivalue;
            } else if self.m_inf != ivalue {
                // previous Inf was opposite sign
                let mut fltv: f64 = f64::from_bits(ivalue as u64);
                fltv -= fltv; // result will be a NaN
                self.m_inf = fltv.to_bits() as i64;
            }
        } else {
            // NaN
            // Choose the NaN with the bigger payload and clear its sign.
            // Using <= ensures that we will choose the first NaN over the previous zero.
            if (self.m_nan & XSUM_MANTISSA_MASK) <= mantissa {
                self.m_nan = ivalue & !XSUM_SIGN_MASK;
            }
        }
    }

    pub(crate) fn add1_no_carry(&mut self, value: f64) {
        let ivalue: i64 = value.to_bits() as i64;

        // Extract exponent and mantissa.  Split exponent into high and low parts.
        let exp: i64 = (ivalue >> XSUM_MANTISSA_BITS) & XSUM_EXP_MASK;
        let mut mantissa: i64 = ivalue & XSUM_MANTISSA_MASK;
        let high_exp: usize = (exp >> XSUM_LOW_EXP_BITS) as usize;
        let mut low_exp: i64 = exp & XSUM_LOW_EXP_MASK;

        // Categorize number as normal, denormalized, or Inf/NaN according to
        // the value of the exponent field.
        if exp == 0 {
            // zero or denormalized
            // If it's a zero (positive or negative), we do nothing.
            if mantissa == 0 {
                return;
            }
            // Denormalized mantissa has no implicit 1, but exponent is 1 not 0.
            low_exp = 1;
        } else if exp == XSUM_EXP_MASK {
            // Inf or NaN
            // Just update flags in accumulator structure.
            self.add_inf_nan(ivalue);
            return;
        } else {
            // normalized
            // OR in implicit 1 bit at top of mantissa
            mantissa |= 1i64 << XSUM_MANTISSA_BITS;
        }

        // Separate mantissa into two parts, after shifting, and add to (or
        // subtract from) this chunk and the next higher chunk (which always
        // exists since there are three extra ones at the top).

        // Note that low_mantissa will have at most XSUM_LOW_MANTISSA_BITS bits,
        // while high_mantissa will have at most XSUM_MANTISSA_BITS bits, since
        // even though the high mantissa includes the extra implicit 1 bit, it will
        // also be shifted right by at least one bit.
        let split_mantissa: [i64; 2] = [
            (mantissa << low_exp) & XSUM_LOW_MANTISSA_MASK,
            mantissa >> (XSUM_LOW_MANTISSA_BITS - low_exp),
        ];

        // Add to, or subtract from, the two affected chunks.
        if ivalue < 0 {
            self.m_chunk[high_exp] -= split_mantissa[0];
            self.m_chunk[high_exp + 1] -= split_mantissa[1];
        } else {
            self.m_chunk[high_exp] += split_mantissa[0];
            self.m_chunk[high_exp + 1] += split_mantissa[1];
        }
    }

    #[inline(always)]
    pub(crate) fn increment_when_value_added(&mut self, value: f64) {
        self.m_size_count += 1;
        self.m_has_pos_number = self.m_has_pos_number || value.is_sign_positive();
    }
}
