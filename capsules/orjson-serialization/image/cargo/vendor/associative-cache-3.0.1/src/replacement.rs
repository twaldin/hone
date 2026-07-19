//! Implementations of various replacement algorithms used when inserting into a
//! full cache.

pub use super::{Capacity, Replacement};

pub mod lru;
pub use lru::*;

/// Choose cache entries to replace in a round-robin order.
///
/// When considering `n` items to potentially replace, first it will replace the
/// `0`th item, and then next time it will replace the `1`st item, ..., then the
/// `n-1`th item, then the `0`th item, etc...
///
/// This replacement policy is simple and fast, but can suffer from harmonics.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RoundRobinReplacement {
    n: usize,
}

impl<V, C> Replacement<V, C> for RoundRobinReplacement
where
    C: Capacity,
{
    #[inline]
    fn choose_for_replacement<'a>(
        &mut self,
        mut candidates: impl ExactSizeIterator<Item = (usize, &'a V)>,
    ) -> usize
    where
        V: 'a,
    {
        let len = candidates.len();
        assert!(len > 0);
        self.n %= len;
        let index = candidates.nth(self.n).unwrap().0;
        self.n += 1;
        index
    }
}

/// Choose a random cache entry to replace.
///
/// When considering `n` items to potentially replace, choose one at random.
///
/// **Requires the `"rand"` feature to be enabled.**
#[cfg(feature = "rand")]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RandomReplacement<R = rand::rngs::StdRng> {
    rng: R,
}

#[cfg(feature = "rand")]
impl Default for RandomReplacement<rand::rngs::StdRng> {
    #[inline]
    fn default() -> Self {
        RandomReplacement { rng: rand::make_rng() }
    }
}

#[cfg(feature = "rand")]
impl<R> RandomReplacement<R> {
    /// Construct a `RandomReplacement` with the given random number generator.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    /// use rand::{rngs::StdRng, SeedableRng};
    ///
    /// let rng = StdRng::seed_from_u64(42);
    /// let policy = RandomReplacement::with_rng(rng);
    /// ```
    #[inline]
    pub fn with_rng(rng: R) -> Self {
        RandomReplacement { rng }
    }
}

#[cfg(feature = "rand")]
impl<V, C, R> Replacement<V, C> for RandomReplacement<R>
where
    C: Capacity,
    R: rand::Rng,
{
    #[inline]
    fn choose_for_replacement<'a>(
        &mut self,
        candidates: impl Iterator<Item = (usize, &'a V)>,
    ) -> usize
    where
        V: 'a,
    {
        use rand::seq::IteratorRandom;
        candidates.choose(&mut self.rng).unwrap().0
    }
}
