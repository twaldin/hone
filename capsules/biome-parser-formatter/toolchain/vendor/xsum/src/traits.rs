use crate::{constants::XSUM_THRESHOLD, xsum_large, xsum_small};

/// Xsum trait
///
/// # Example
///
/// ```
/// use xsum::{Xsum, XsumSmall};
///
/// let mut xsmall = XsumSmall::new();
/// xsmall.add_list(&vec![1.0, 2.0, 3.0]);
/// assert_eq!(xsmall.sum(), 6.0);
///
/// let vec = vec![1.0, 2.0, 3.0];
/// for v in vec {
///     xsmall.add(v);
/// }
/// assert_eq!(xsmall.sum(), 12.0);
///
/// xsmall.clear();
/// let res = xsmall.sum(); // -0.0
/// assert_eq!(res, -0.0);
/// assert!(res.is_sign_negative());
/// ```
pub trait Xsum {
    fn new() -> Self;
    fn add_list(&mut self, vec: &[f64]);
    fn add(&mut self, value: f64);
    fn sum(&mut self) -> f64;
    fn clear(&mut self);
}

/// XsumExt selects either XsumSmall or XsumLarge based on the number of elements of vector or array
///
/// If the size if less than or equal to 1,000, use XsumSmall, otherwise, use XsumLarge
///
/// # Example
///
/// ```
/// use xsum::{Xsum, XsumExt};
///
/// let vec = vec![1.0, 2.0, 3.0];
/// assert_eq!(vec.xsum(), 6.0);
/// ```
pub trait XsumExt {
    fn xsum(&self) -> f64;
}

impl XsumExt for [f64] {
    fn xsum(&self) -> f64 {
        if self.len() < XSUM_THRESHOLD {
            let mut xsumsmall = xsum_small::XsumSmall::new();
            xsumsmall.add_list(self);
            xsumsmall.sum()
        } else {
            let mut xsumlarge = xsum_large::XsumLarge::new();
            xsumlarge.add_list(self);
            xsumlarge.sum()
        }
    }
}
