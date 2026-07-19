use crate::{
    accumulators::large_accumulator::LargeAccumulator, constants::XSUM_MANTISSA_BITS, traits::Xsum,
    xsum_small::XsumSmall,
};

/// XsumLarge is efficient when vector or array size is more than 1,000
///
/// # Example
///
/// ```
/// use xsum::{Xsum, XsumLarge};
///
/// let mut xlarge = XsumLarge::new();
/// xlarge.add_list(&vec![1.0; 1_000]);
/// assert_eq!(xlarge.sum(), 1_000.0);
/// ```
#[cfg_attr(debug_assertions, derive(Debug))]
pub struct XsumLarge {
    m_lacc: LargeAccumulator,
}

impl Default for XsumLarge {
    fn default() -> Self {
        Self::new()
    }
}

impl XsumLarge {
    #[must_use]
    pub fn from_xsum_small(xsmall: XsumSmall) -> Self {
        let mut lacc = LargeAccumulator::new();
        lacc.m_sacc = xsmall.transfer_accumulator();
        Self { m_lacc: lacc }
    }
}

impl Xsum for XsumLarge {
    fn new() -> Self {
        Self {
            m_lacc: LargeAccumulator::new(),
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumLarge};
    ///
    /// let mut xlarge = XsumLarge::new();
    /// xlarge.add_list(&vec![1.0; 1_000]);
    /// assert_eq!(xlarge.sum(), 1_000.0);
    /// ```
    fn add_list(&mut self, vec: &[f64]) {
        for &value in vec {
            self.add(value);
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumLarge};
    ///
    /// let mut xlarge = XsumLarge::new();
    /// let vec = vec![1.0; 1_000];
    /// for v in vec {
    ///     xlarge.add(v);
    /// }
    /// assert_eq!(xlarge.sum(), 1_000.0);
    /// ```
    #[inline(always)]
    fn add(&mut self, value: f64) {
        // increment
        self.m_lacc.m_sacc.increment_when_value_added(value);

        // Convert to integer form in uintv
        let uintv: u64 = value.to_bits();

        // Isolate the upper sign+exponent bits that index the chunk.
        let ix: usize = (uintv >> XSUM_MANTISSA_BITS) as usize;

        // Find the count for this chunk, and subtract one.
        let count: i32 = self.m_lacc.m_count[ix] - 1;

        if count < 0 {
            // If the decremented count is negative, it's either a special
            // Inf/NaN chunk (in which case count will stay at -1), or one that
            // needs to be transferred to the small accumulator, or one that
            // has never been used before and needs to be initialized.
            self.m_lacc.large_add_value_inf_nan(ix, uintv);
        } else {
            // Store the decremented count of additions allowed before transfer,
            // and add this value to the chunk.
            self.m_lacc.m_count[ix] = count;
            self.m_lacc.m_chunk[ix] = self.m_lacc.m_chunk[ix].wrapping_add(uintv);
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumLarge};
    ///
    /// let mut xlarge = XsumLarge::new();
    /// xlarge.add_list(&vec![1.0; 1_000]);
    /// assert_eq!(xlarge.sum(), 1_000.0);
    /// ```
    fn sum(&mut self) -> f64 {
        self.m_lacc.transfer_to_small();
        let mut xsum_smal = XsumSmall::new_with(&self.m_lacc.m_sacc);
        xsum_smal.sum()
    }

    /// ```
    /// use xsum::{Xsum, XsumLarge};
    ///
    /// let mut xlarge = XsumLarge::new();
    /// xlarge.add_list(&vec![1.0; 1_000]);
    /// assert_eq!(xlarge.sum(), 1_000.0);
    ///
    /// xlarge.clear();
    /// let res = xlarge.sum(); // -0.0
    /// assert_eq!(res, -0.0);
    /// assert!(res.is_sign_negative());
    /// ```
    fn clear(&mut self) {
        *self = Self::default();
    }
}
