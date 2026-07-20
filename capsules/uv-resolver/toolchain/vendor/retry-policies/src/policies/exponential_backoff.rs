use crate::{Jitter, RetryDecision, RetryPolicy};
use std::{
    cmp::{self, min},
    time::{Duration, SystemTime},
};

/// Exponential backoff with optional jitter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct ExponentialBackoff {
    /// Maximum number of allowed retries attempts.
    pub max_n_retries: Option<u32>,
    /// Minimum waiting time between two retry attempts (it can end up being lower due to jitter).
    pub min_retry_interval: Duration,
    /// Maximum waiting time between two retry attempts.
    pub max_retry_interval: Duration,
    /// How we apply jitter to the calculated backoff intervals.
    pub jitter: Jitter,
    /// Base of the exponential
    pub base: u32,
}

/// Exponential backoff with a maximum retry duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExponentialBackoffTimed {
    /// Maximum duration the retries can continue for, after which retries will stop.
    max_total_retry_duration: Duration,

    backoff: ExponentialBackoff,
}

/// Builds an exponential backoff policy.
///
/// # Example
///
/// ```rust
/// use retry_policies::{RetryDecision, RetryPolicy, Jitter};
/// use retry_policies::policies::ExponentialBackoff;
/// use std::time::Duration;
///
/// let backoff = ExponentialBackoff::builder()
///     .retry_bounds(Duration::from_secs(1), Duration::from_secs(60))
///     .jitter(Jitter::Bounded)
///     .base(2)
///     .build_with_total_retry_duration(Duration::from_secs(24 * 60 * 60));
/// ```
pub struct ExponentialBackoffBuilder {
    min_retry_interval: Duration,
    max_retry_interval: Duration,
    jitter: Jitter,
    base: u32,
}

impl ExponentialBackoff {
    /// Returns a builder.
    ///
    /// # Example
    /// ```
    /// use retry_policies::policies::ExponentialBackoff;
    /// use std::time::Duration;
    ///
    /// let backoff = ExponentialBackoff::builder()
    ///     .build_with_max_retries(5);
    ///
    /// assert_eq!(backoff.min_retry_interval, Duration::from_secs(1));
    /// assert_eq!(backoff.max_retry_interval, Duration::from_secs(30 * 60));
    /// assert_eq!(backoff.max_n_retries, Some(5));
    /// assert_eq!(backoff.base, 2);
    /// ```
    pub fn builder() -> ExponentialBackoffBuilder {
        <_>::default()
    }

    fn too_many_attempts(&self, n_past_retries: u32) -> bool {
        self.max_n_retries
            .is_some_and(|max_n| max_n <= n_past_retries)
    }
}

impl RetryPolicy for ExponentialBackoff {
    fn should_retry(&self, _request_start_time: SystemTime, n_past_retries: u32) -> RetryDecision {
        if self.too_many_attempts(n_past_retries) {
            RetryDecision::DoNotRetry
        } else {
            let unjittered_wait_for = min(
                self.max_retry_interval,
                self.min_retry_interval * calculate_exponential(self.base, n_past_retries),
            );

            let jittered_wait_for = self.jitter.apply(
                unjittered_wait_for,
                self.min_retry_interval,
                &mut rand::rng(),
            );

            let execute_after =
                SystemTime::now() + clip(jittered_wait_for, self.max_retry_interval);
            RetryDecision::Retry { execute_after }
        }
    }
}

/// Clip to the maximum allowed retry interval.
fn clip(duration: Duration, max_duration: Duration) -> Duration {
    cmp::min(duration, max_duration)
}

/// Calculate exponential using base and number of past retries
fn calculate_exponential(base: u32, n_past_retries: u32) -> u32 {
    base.checked_pow(n_past_retries).unwrap_or(u32::MAX)
}

impl ExponentialBackoffTimed {
    /// Maximum number of allowed retries attempts.
    pub fn max_retries(&self) -> Option<u32> {
        self.backoff.max_n_retries
    }

    fn trying_for_too_long(&self, started_at: SystemTime) -> bool {
        self.max_total_retry_duration <= Self::elapsed(started_at)
    }

    fn elapsed(started_at: SystemTime) -> Duration {
        SystemTime::now()
            .duration_since(started_at)
            // If `started_at` is in the future then return a zero duration.
            .unwrap_or_default()
    }
}

impl Default for ExponentialBackoffBuilder {
    fn default() -> Self {
        Self {
            min_retry_interval: Duration::from_secs(1),
            max_retry_interval: Duration::from_secs(30 * 60),
            jitter: Jitter::Full,
            base: 2,
        }
    }
}

impl RetryPolicy for ExponentialBackoffTimed {
    fn should_retry(&self, request_start_time: SystemTime, n_past_retries: u32) -> RetryDecision {
        if self.trying_for_too_long(request_start_time) {
            return RetryDecision::DoNotRetry;
        }
        self.backoff
            .should_retry(request_start_time, n_past_retries)
    }
}

impl ExponentialBackoffBuilder {
    /// Add min & max retry interval bounds. _Default [1s, 30m]_.
    ///
    /// See [`ExponentialBackoff::min_retry_interval`], [`ExponentialBackoff::max_retry_interval`].
    ///
    /// Panics if `min_retry_interval` > `max_retry_interval`.
    pub fn retry_bounds(
        mut self,
        min_retry_interval: Duration,
        max_retry_interval: Duration,
    ) -> Self {
        assert!(
            min_retry_interval <= max_retry_interval,
            "The maximum interval between retries should be greater or equal than the minimum retry interval."
        );
        self.min_retry_interval = min_retry_interval;
        self.max_retry_interval = max_retry_interval;
        self
    }

    /// Set what type of jitter to apply.
    pub fn jitter(mut self, jitter: Jitter) -> Self {
        self.jitter = jitter;
        self
    }

    /// Set what base to use for the exponential.
    pub fn base(mut self, base: u32) -> Self {
        self.base = base;
        self
    }

    /// Builds an [`ExponentialBackoff`] with the given maximum retries.
    ///
    /// See [`ExponentialBackoff::max_n_retries`].
    pub fn build_with_max_retries(self, n: u32) -> ExponentialBackoff {
        ExponentialBackoff {
            min_retry_interval: self.min_retry_interval,
            max_retry_interval: self.max_retry_interval,
            max_n_retries: Some(n),
            jitter: self.jitter,
            base: self.base,
        }
    }

    /// Builds an [`ExponentialBackoff`] with the given maximum total duration for which retries will
    /// continue to be performed.
    ///
    /// # Example
    ///
    /// ```rust
    /// use retry_policies::{RetryDecision, RetryPolicy};
    /// use retry_policies::policies::ExponentialBackoff;
    /// use std::time::{Duration, SystemTime};
    ///
    /// let backoff = ExponentialBackoff::builder()
    ///     .build_with_total_retry_duration(Duration::from_secs(24 * 60 * 60));
    ///
    /// let started_at = SystemTime::now()
    ///     .checked_sub(Duration::from_secs(25 * 60 * 60))
    ///     .unwrap();
    ///
    /// let should_retry = backoff.should_retry(started_at, 0);
    /// assert!(matches!(RetryDecision::DoNotRetry, should_retry));
    /// ```
    pub fn build_with_total_retry_duration(
        self,
        total_duration: Duration,
    ) -> ExponentialBackoffTimed {
        ExponentialBackoffTimed {
            max_total_retry_duration: total_duration,
            backoff: ExponentialBackoff {
                min_retry_interval: self.min_retry_interval,
                max_retry_interval: self.max_retry_interval,
                max_n_retries: None,
                jitter: self.jitter,
                base: self.base,
            },
        }
    }

    /// Builds an [`ExponentialBackoffTimed`] with the given maximum total duration and limits the
    /// number of retries to a calculated maximum.
    ///
    /// This calculated maximum is based on how many attempts would be made without jitter applied.
    ///
    /// For example if we set total duration 24 hours, with retry bounds [1s, 24h] and 2 as base of
    /// the exponential, we would calculate 17 max retries, as 1s * pow(2, 16) = 65536s = ~18 hours
    /// and 18th attempt would be way after the 24 hours total duration.
    ///
    /// If the 17th retry ends up being scheduled after 10 hours due to jitter,
    /// [`ExponentialBackoff::should_retry`] will return false anyway: no retry will be allowed
    /// after total duration.
    ///
    /// If one of the 17 allowed retries for some reason (e.g. previous attempts taking a long time)
    /// ends up being scheduled after total duration, [`ExponentialBackoff::should_retry`] will
    /// return false.
    ///
    /// Basically we will enforce whatever comes first, max retries or total duration.
    ///
    /// # Example
    ///
    /// ```rust
    /// use retry_policies::{RetryDecision, RetryPolicy};
    /// use retry_policies::policies::ExponentialBackoff;
    /// use std::time::{Duration, SystemTime};
    ///
    /// let exponential_backoff_timed = ExponentialBackoff::builder()
    ///     .retry_bounds(Duration::from_secs(1), Duration::from_secs(6 * 60 * 60))
    ///     .build_with_total_retry_duration_and_limit_retries(Duration::from_secs(24 * 60 * 60));
    ///
    /// assert_eq!(exponential_backoff_timed.max_retries(), Some(17));
    ///
    /// let started_at = SystemTime::now()
    ///     .checked_sub(Duration::from_secs(25 * 60 * 60))
    ///     .unwrap();
    ///
    /// let should_retry = exponential_backoff_timed.should_retry(started_at, 0);
    /// assert!(matches!(RetryDecision::DoNotRetry, should_retry));
    ///
    /// let started_at = SystemTime::now()
    ///     .checked_sub(Duration::from_secs(1 * 60 * 60))
    ///     .unwrap();
    ///
    /// let should_retry = exponential_backoff_timed.should_retry(started_at, 18);
    /// assert!(matches!(RetryDecision::DoNotRetry, should_retry));
    ///
    /// ```
    pub fn build_with_total_retry_duration_and_limit_retries(
        self,
        total_duration: Duration,
    ) -> ExponentialBackoffTimed {
        let mut max_n_retries = None;

        let delays = (0u32..).map(|n| {
            min(
                self.max_retry_interval,
                self.min_retry_interval * calculate_exponential(self.base, n),
            )
        });

        let mut total = Duration::from_secs(0);
        for (n, delay) in delays.enumerate() {
            total += delay;
            if total >= total_duration {
                max_n_retries = Some(n as _);
                break;
            }
        }

        ExponentialBackoffTimed {
            max_total_retry_duration: total_duration,
            backoff: ExponentialBackoff {
                min_retry_interval: self.min_retry_interval,
                max_retry_interval: self.max_retry_interval,
                max_n_retries,
                jitter: self.jitter,
                base: self.base,
            },
        }
    }

    /// Builds an [`ExponentialBackoffTimed`] with the given maximum total duration and maximum retries.
    pub fn build_with_total_retry_duration_and_max_retries(
        self,
        total_duration: Duration,
        max_n_retries: u32,
    ) -> ExponentialBackoffTimed {
        ExponentialBackoffTimed {
            max_total_retry_duration: total_duration,
            backoff: ExponentialBackoff {
                min_retry_interval: self.min_retry_interval,
                max_retry_interval: self.max_retry_interval,
                max_n_retries: Some(max_n_retries),
                jitter: self.jitter,
                base: self.base,
            },
        }
    }
}
#[cfg(test)]
mod tests {
    use std::convert::TryFrom as _;

    use rand::distr::{Distribution, Uniform};

    use super::*;

    fn get_retry_policy() -> ExponentialBackoff {
        ExponentialBackoff {
            max_n_retries: Some(6),
            min_retry_interval: Duration::from_secs(1),
            max_retry_interval: Duration::from_secs(5 * 60),
            jitter: Jitter::Full,
            base: 2,
        }
    }

    #[test]
    fn if_n_past_retries_is_below_maximum_it_decides_to_retry() {
        // Arrange
        let policy = get_retry_policy();
        let n_past_retries = Uniform::try_from(0..policy.max_n_retries.unwrap())
            .unwrap()
            .sample(&mut rand::rng());
        assert!(n_past_retries < policy.max_n_retries.unwrap());

        // Act
        let decision = policy.should_retry(SystemTime::now(), n_past_retries);

        // Assert
        matches!(decision, RetryDecision::Retry { .. });
    }

    #[test]
    fn if_n_past_retries_is_above_maximum_it_decides_to_mark_as_failed() {
        // Arrange
        let policy = get_retry_policy();
        let n_past_retries = Uniform::try_from(policy.max_n_retries.unwrap()..=u32::MAX)
            .unwrap()
            .sample(&mut rand::rng());
        assert!(n_past_retries >= policy.max_n_retries.unwrap());

        // Act
        let decision = policy.should_retry(SystemTime::now(), n_past_retries);

        // Assert
        matches!(decision, RetryDecision::DoNotRetry);
    }

    #[test]
    fn maximum_retry_interval_is_never_exceeded() {
        // Arrange
        let policy = get_retry_policy();
        let max_interval = policy.max_retry_interval;

        // Act
        let decision = policy.should_retry(SystemTime::now(), policy.max_n_retries.unwrap() - 1);

        // Assert
        match decision {
            RetryDecision::Retry { execute_after } => {
                assert!(execute_after.duration_since(SystemTime::now()).unwrap() <= max_interval)
            }
            RetryDecision::DoNotRetry => panic!("Expected Retry decision."),
        }
    }

    #[test]
    fn overflow_backoff_exponent_does_not_cause_a_panic() {
        let policy = ExponentialBackoff {
            max_n_retries: Some(u32::MAX),
            ..get_retry_policy()
        };
        let max_interval = policy.max_retry_interval;
        let n_failed_attempts = u32::MAX - 1;

        // Act
        let decision = policy.should_retry(SystemTime::now(), n_failed_attempts);

        // Assert
        match decision {
            RetryDecision::Retry { execute_after } => {
                assert!(execute_after.duration_since(SystemTime::now()).unwrap() <= max_interval)
            }
            RetryDecision::DoNotRetry => panic!("Expected Retry decision."),
        }
    }

    #[test]
    #[should_panic]
    fn builder_invalid_retry_bounds() {
        // bounds are the wrong way round or invalid
        ExponentialBackoff::builder().retry_bounds(Duration::from_secs(3), Duration::from_secs(2));
    }

    #[test]
    fn does_not_retry_after_total_retry_duration() {
        let backoff = ExponentialBackoff::builder()
            .build_with_total_retry_duration(Duration::from_secs(24 * 60 * 60));

        {
            let started_at = SystemTime::now()
                .checked_sub(Duration::from_secs(23 * 60 * 60))
                .unwrap();

            let decision = backoff.should_retry(started_at, 0);

            match decision {
                RetryDecision::Retry { .. } => {}
                _ => panic!("should retry"),
            }
        }
        {
            let started_at = SystemTime::now()
                .checked_sub(Duration::from_secs(25 * 60 * 60))
                .unwrap();

            let decision = backoff.should_retry(started_at, 0);

            match decision {
                RetryDecision::DoNotRetry => {}
                _ => panic!("should not retry"),
            }
        }
    }

    #[test]
    fn does_not_retry_before_total_retry_duration_if_max_retries_exceeded() {
        let backoff = ExponentialBackoff::builder()
            // This configuration should allow 17 max retries inside a 24h total duration
            .retry_bounds(Duration::from_secs(1), Duration::from_secs(6 * 60 * 60))
            .build_with_total_retry_duration_and_limit_retries(Duration::from_secs(24 * 60 * 60));

        {
            let started_at = SystemTime::now()
                .checked_sub(Duration::from_secs(23 * 60 * 60))
                .unwrap();

            let decision = backoff.should_retry(started_at, 0);

            match decision {
                RetryDecision::Retry { .. } => {}
                _ => panic!("should retry"),
            }
        }
        {
            let started_at = SystemTime::now()
                .checked_sub(Duration::from_secs(23 * 60 * 60))
                .unwrap();

            // Zero based, so this is the 18th retry
            let decision = backoff.should_retry(started_at, 17);

            match decision {
                RetryDecision::DoNotRetry => {}
                _ => panic!("should not retry"),
            }
        }
        {
            let started_at = SystemTime::now()
                .checked_sub(Duration::from_secs(25 * 60 * 60))
                .unwrap();

            let decision = backoff.should_retry(started_at, 0);

            match decision {
                RetryDecision::DoNotRetry => {}
                _ => panic!("should not retry"),
            }
        }
    }

    #[test]
    fn different_exponential_base_produce_different_max_retries_for_the_same_duration() {
        let backoff_base_2 = ExponentialBackoff::builder()
            .retry_bounds(Duration::from_secs(1), Duration::from_secs(60 * 60))
            .base(2)
            .build_with_total_retry_duration_and_limit_retries(Duration::from_secs(60 * 60));

        let backoff_base_3 = ExponentialBackoff::builder()
            .retry_bounds(Duration::from_secs(1), Duration::from_secs(60 * 60))
            .base(3)
            .build_with_total_retry_duration_and_limit_retries(Duration::from_secs(60 * 60));

        let backoff_base_4 = ExponentialBackoff::builder()
            .retry_bounds(Duration::from_secs(1), Duration::from_secs(60 * 60))
            .base(4)
            .build_with_total_retry_duration_and_limit_retries(Duration::from_secs(60 * 60));

        assert_eq!(backoff_base_2.max_retries().unwrap(), 11);
        assert_eq!(backoff_base_3.max_retries().unwrap(), 8);
        assert_eq!(backoff_base_4.max_retries().unwrap(), 6);
    }

    #[test]
    fn total_retry_duration_and_max_retries() {
        // Create backoff policy with specific duration and retry limits
        let backoff = ExponentialBackoff::builder()
            .retry_bounds(Duration::from_secs(1), Duration::from_secs(30))
            .build_with_total_retry_duration_and_max_retries(Duration::from_secs(120), 5);

        // Verify the max retries was set correctly
        assert_eq!(backoff.max_retries(), Some(5));

        // Test retry within limits
        {
            let started_at = SystemTime::now()
                .checked_sub(Duration::from_secs(60))
                .unwrap();

            let decision = backoff.should_retry(started_at, 3);

            match decision {
                RetryDecision::Retry { .. } => {}
                _ => panic!("Should retry when within both retry count and duration limits"),
            }
        }

        // Test retry exceed max retries
        {
            let started_at = SystemTime::now()
                .checked_sub(Duration::from_secs(60))
                .unwrap();

            let decision = backoff.should_retry(started_at, 5);

            match decision {
                RetryDecision::DoNotRetry => {}
                _ => panic!("Should not retry when max retries exceeded"),
            }
        }

        // Test retry exceed duration
        {
            let started_at = SystemTime::now()
                .checked_sub(Duration::from_secs(150))
                .unwrap();

            let decision = backoff.should_retry(started_at, 3);

            match decision {
                RetryDecision::DoNotRetry => {}
                _ => panic!("Should not retry when time duration exceeded"),
            }
        }
    }
}
