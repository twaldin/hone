use crate::{Xsum, XsumAuto, XsumLarge, XsumSmall};

/// `XsumVariant` provides an easy way to manage multiple xsum variants.
///
/// This is useful when you want to adjust behavior based on the input size.
/// For example, `XsumAuto` can automatically choose the appropriate xsum variant,
/// which is useful when the input size is unknown.
/// However, it has some overhead to determine when to switch from `XsumSmall` to `XsumLarge`.
///
/// If you already know the input size in advance, you can directly select the
/// most suitable xsum variant, avoiding unnecessary overhead.
///
/// # Example
///
/// ```
/// use xsum::{Xsum, XsumVariant, XsumAuto, XsumLarge, XsumSmall, constants::XSUM_THRESHOLD};
///
/// let vec = vec![1.0; 2_000];
/// let mut xVariant = if vec.len() < XSUM_THRESHOLD {
///   XsumVariant::Small(XsumSmall::new())
/// } else {
///   XsumVariant::Large(XsumLarge::new())
/// };
/// xVariant.add_list(&vec);
/// assert_eq!(xVariant.sum(), 2_000.0);
/// ```
pub enum XsumVariant {
    Small(XsumSmall),
    Large(XsumLarge),
    Auto(XsumAuto),
}

impl Xsum for XsumVariant {
    /// Returns the default value. See [`XsumVariant::default`] for more information.
    fn new() -> Self {
        Self::default()
    }

    /// ```
    /// use xsum::{Xsum, XsumVariant, XsumAuto, XsumLarge, XsumSmall, constants::XSUM_THRESHOLD};
    ///
    /// let vec = vec![1.0; 2_000];
    /// let mut xVariant = if vec.len() < XSUM_THRESHOLD {
    ///   XsumVariant::Small(XsumSmall::new())
    /// } else {
    ///   XsumVariant::Large(XsumLarge::new())
    /// };
    /// xVariant.add_list(&vec);
    /// assert_eq!(xVariant.sum(), 2_000.0);
    /// ```
    fn add_list(&mut self, vec: &[f64]) {
        match self {
            Self::Small(xsum_small) => xsum_small.add_list(vec),
            Self::Large(xsum_large) => xsum_large.add_list(vec),
            Self::Auto(xsum_auto) => xsum_auto.add_list(vec),
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumVariant, XsumAuto, XsumLarge, XsumSmall, constants::XSUM_THRESHOLD};
    ///
    /// let vec = vec![1.0; 2_000];
    /// let mut xVariant = if vec.len() < XSUM_THRESHOLD {
    ///   XsumVariant::Small(XsumSmall::new())
    /// } else {
    ///   XsumVariant::Large(XsumLarge::new())
    /// };
    /// for val in vec {
    ///   xVariant.add(val);
    /// }
    /// assert_eq!(xVariant.sum(), 2_000.0);
    /// ```
    #[inline(always)]
    fn add(&mut self, value: f64) {
        match self {
            Self::Small(xsum_small) => xsum_small.add(value),
            Self::Large(xsum_large) => xsum_large.add(value),
            Self::Auto(xsum_auto) => xsum_auto.add(value),
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumVariant, XsumAuto, XsumLarge, XsumSmall, constants::XSUM_THRESHOLD};
    ///
    /// let vec = vec![1.0; 2_000];
    /// let mut xVariant = if vec.len() < XSUM_THRESHOLD {
    ///   XsumVariant::Small(XsumSmall::new())
    /// } else {
    ///   XsumVariant::Large(XsumLarge::new())
    /// };
    /// xVariant.add_list(&vec);
    /// assert_eq!(xVariant.sum(), 2_000.0);
    /// ```
    fn sum(&mut self) -> f64 {
        match self {
            Self::Small(xsum_small) => xsum_small.sum(),
            Self::Large(xsum_large) => xsum_large.sum(),
            Self::Auto(xsum_auto) => xsum_auto.sum(),
        }
    }

    /// ```
    /// use xsum::{Xsum, XsumVariant, XsumAuto, XsumLarge, XsumSmall, constants::XSUM_THRESHOLD};
    ///
    /// let vec = vec![1.0; 2_000];
    /// let mut xVariant = if vec.len() < XSUM_THRESHOLD {
    ///   XsumVariant::Small(XsumSmall::new())
    /// } else {
    ///   XsumVariant::Large(XsumLarge::new())
    /// };
    /// xVariant.add_list(&vec);
    /// assert_eq!(xVariant.sum(), 2_000.0);
    /// xVariant.clear();
    /// assert_eq!(xVariant.sum(), 0.0);
    /// ```
    fn clear(&mut self) {
        match self {
            Self::Small(xsum_small) => xsum_small.clear(),
            Self::Large(xsum_large) => xsum_large.clear(),
            Self::Auto(xsum_auto) => xsum_auto.clear(),
        }
    }
}

impl Default for XsumVariant {
    /// Returns `XsumVariant::Small(XsumSmall::new())`
    fn default() -> Self {
        Self::Small(XsumSmall::new())
    }
}
