use std::time::{Duration, SystemTime};

use rand::{
    distr::uniform::{UniformFloat, UniformSampler},
    Rng,
};

/// A policy for deciding whether and when to retry.
pub trait RetryPolicy {
    /// Determine if a task should be retried according to a retry policy.
    fn should_retry(&self, request_start_time: SystemTime, n_past_retries: u32) -> RetryDecision;
}

/// Outcome of evaluating a retry policy for a failed task.
#[derive(Debug)]
pub enum RetryDecision {
    /// Retry after the specified timestamp.
    Retry { execute_after: SystemTime },
    /// Give up.
    DoNotRetry,
}

/// How to apply jitter to the retry intervals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Jitter {
    /// Don't apply any jitter.
    None,
    /// Jitter between 0 and the calculated backoff duration.
    Full,
    /// Jitter between 50% of `min_retry_interval` and the calculated backoff duration.
    Bounded,
}

impl Jitter {
    /// The lower bound for the calculated interval, as a fraction of the minimum
    /// interval.
    const BOUNDED_MIN_BOUND_FRACTION: f64 = 0.5;

    pub(crate) fn apply(
        &self,
        interval: Duration,
        min_interval: Duration,
        rng: &mut impl Rng,
    ) -> Duration {
        match self {
            Jitter::None => interval,
            Jitter::Full => {
                let jitter_factor = UniformFloat::<f64>::sample_single(0.0, 1.0, rng)
                    .expect("Sample range should be valid");

                interval.mul_f64(jitter_factor)
            }
            Jitter::Bounded => {
                let jitter_factor = UniformFloat::<f64>::sample_single(0.0, 1.0, rng)
                    .expect("Sample range should be valid");

                let jittered_wait_for = (interval
                    - min_interval.mul_f64(Self::BOUNDED_MIN_BOUND_FRACTION))
                .mul_f64(jitter_factor);

                jittered_wait_for + min_interval.mul_f64(Self::BOUNDED_MIN_BOUND_FRACTION)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use rand::{rngs::StdRng, SeedableRng};

    use super::*;
    use std::time::Duration;

    const SEED: u64 = 3097268606784207815;

    #[test]
    fn test_jitter_none() {
        let jitter = Jitter::None;
        let min_interval = Duration::from_secs(5);
        let interval = Duration::from_secs(10);
        assert_eq!(
            jitter.apply(interval, min_interval, &mut rand::rng()),
            interval,
        );
    }

    #[test]
    fn test_jitter_full() {
        let jitter = Jitter::Full;
        let min_interval = Duration::from_secs(5);
        let interval = Duration::from_secs(10);
        let result = jitter.apply(interval, min_interval, &mut rand::rng());
        assert!(result >= Duration::ZERO && result <= interval);
    }

    #[test]
    fn test_jitter_bounded() {
        let jitter = Jitter::Bounded;
        let min_interval = Duration::from_secs(5);
        let interval = Duration::from_secs(10);
        let result = jitter.apply(interval, min_interval, &mut rand::rng());
        assert!(
            result >= min_interval.mul_f64(Jitter::BOUNDED_MIN_BOUND_FRACTION)
                && result <= interval
        );
    }

    #[test]
    fn test_jitter_bounded_first_retry() {
        let jitter = Jitter::Bounded;
        let min_interval = Duration::from_secs(1);
        let interval = min_interval;
        let mut rng: StdRng = SeedableRng::seed_from_u64(SEED);
        let result = jitter.apply(interval, min_interval, &mut rng);
        assert!(
            result < interval,
            "should have jittered to below the min interval"
        );
        assert_eq!(result, Duration::from_nanos(708_215_236));
    }
}
