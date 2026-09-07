use crate::{constants::XSUM_THRESHOLD, traits::Xsum, XsumLarge, XsumSmall};

#[cfg_attr(debug_assertions, derive(Debug))]
enum XsumKind {
    XSmall(XsumSmall),
    XLarge(XsumLarge),
}

/// XsumAuto is efficient when vector or array size is unknown
///
/// It automatically select either XsumSmall or XsumLarge based on the number of added value
///
/// If the size if less than or equal to 1,000, use XsumSmall, otherwise, use XsumLarge
///
/// # Example
///
/// ```
/// use xsum::{Xsum, XsumAuto};
///
/// let mut xauto = XsumAuto::new();
/// xauto.add_list(&vec![1.0; 10]);
/// assert_eq!(xauto.sum(), 10.0); // use XsumSmall because input size is 10
///
/// xauto.add_list(&vec![1.0; 1_000]);
/// assert_eq!(xauto.sum(), 1_010.0); // use XsumLarge because input size is 1,010 in total
/// ```
#[cfg_attr(debug_assertions, derive(Debug))]
pub struct XsumAuto {
    m_xsum: XsumKind,
}

impl Default for XsumAuto {
    fn default() -> Self {
        Self::new()
    }
}

impl XsumAuto {
    #[inline(always)]
    fn transform_to_large(&mut self) {
        let should_transform = match &self.m_xsum {
            XsumKind::XSmall(xsmall) => xsmall.get_size_count() > XSUM_THRESHOLD,
            XsumKind::XLarge(_) => false,
        };
        if !should_transform {
            return;
        }

        let old_xsum = std::mem::replace(&mut self.m_xsum, XsumKind::XSmall(XsumSmall::default()));

        self.m_xsum = match old_xsum {
            XsumKind::XSmall(xsmall) => XsumKind::XLarge(XsumLarge::from_xsum_small(xsmall)),
            other @ XsumKind::XLarge(_) => other,
        };
    }
}

impl Xsum for XsumAuto {
    fn new() -> Self {
        Self {
            m_xsum: XsumKind::XSmall(XsumSmall::new()),
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumAuto};
    ///
    /// let mut xauto = XsumAuto::new();
    /// xauto.add_list(&vec![1.0; 10]);
    /// assert_eq!(xauto.sum(), 10.0);
    /// ```
    fn add_list(&mut self, vec: &[f64]) {
        match &mut self.m_xsum {
            XsumKind::XSmall(xsmal) => {
                xsmal.add_list(vec);
                self.transform_to_large();
            }
            XsumKind::XLarge(xlarge) => {
                xlarge.add_list(vec);
            }
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumAuto};
    ///
    /// let mut xauto = XsumAuto::new();
    /// let vec = vec![1.0; 1_000];
    /// for v in vec {
    ///     xauto.add(v);
    /// }
    /// assert_eq!(xauto.sum(), 1_000.0);
    /// ```
    #[inline(always)]
    fn add(&mut self, value: f64) {
        match &mut self.m_xsum {
            XsumKind::XSmall(xsmal) => {
                xsmal.add(value);
                self.transform_to_large();
            }
            XsumKind::XLarge(xlarge) => {
                xlarge.add(value);
            }
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumAuto};
    ///
    /// let mut xauto = XsumAuto::new();
    /// xauto.add_list(&vec![1.0; 10]);
    /// assert_eq!(xauto.sum(), 10.0);
    /// ```
    fn sum(&mut self) -> f64 {
        match &mut self.m_xsum {
            XsumKind::XSmall(xsmall) => xsmall.sum(),
            XsumKind::XLarge(xlarge) => xlarge.sum(),
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumAuto};
    ///
    /// let mut xauto = XsumAuto::new();
    /// xauto.add_list(&vec![1.0; 10]);
    /// assert_eq!(xauto.sum(), 10.0);
    ///
    /// xauto.clear();
    /// let res = xauto.sum(); // -0.0
    /// assert_eq!(res, -0.0);
    /// assert!(res.is_sign_negative());
    /// ```
    fn clear(&mut self) {
        *self = Self::default();
    }
}
