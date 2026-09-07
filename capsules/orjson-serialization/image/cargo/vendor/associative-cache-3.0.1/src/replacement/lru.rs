//! Least recently used (LRU) replacement policy implementation and traits for
//! working with LRU timestamps.

use super::*;
use std::cell::Cell;
use std::ops::{Deref, DerefMut};
use std::time::Instant;

/// A trait for anything that has a timestamp that we can use with an LRU cache
/// replacement policy.
///
/// Don't already have a timestamp in your cache value? Consider using the
/// `WithLruTimestamp<T>` wrapper type around your cache value. That is likely a
/// little easier than implementing this trait yourself.
pub trait LruTimestamp {
    /// The timestamp type that will be compared.
    ///
    /// The entry with smallest timestamp value (according to its `PartialOrd`
    /// implementation) is the one that will be replaced.
    type Timestamp<'a>: PartialOrd
    where
        Self: 'a;

    /// Get this cache value's timestamp.
    fn get_timestamp(&self) -> Self::Timestamp<'_>;

    /// Update this cache value's timestamp.
    ///
    /// Note that this takes `&self`, not `&mut self`, because this is called on
    /// all cache hits, where we don't necessarily have `&mut` access to the
    /// cache. It is up to implementors to use internal mutability to update the
    /// timestamp.
    fn update_timestamp(&self);
}

/// A wrapper around a `T` cache value that maintains a timestamp for use with
/// LRU cache replacement policies.
///
/// Provides `Deref[Mut]` and `As{Ref,Mut}` implementations, so it is easy to
/// drop in with minimal source changes.
///
/// You can recover ownership of the inner `T` value via
/// `WithLruTimestamp::into_inner(x)` once a value has been removed from the
/// cache.
///
/// # Example
///
/// ```
/// use associative_cache::*;
///
/// let cache = AssociativeCache::<
///     String,
///     // Wrap your cache value in `WithLruTimestamp`...
///     WithLruTimestamp<usize>,
///     Capacity128,
///     HashEightWay,
///     // ... and take advantage of LRU cache replacement!
///     LruReplacement,
/// >::default();
/// ```
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct WithLruTimestamp<T> {
    timestamp: Cell<Instant>,
    inner: T,
}

impl<T> Default for WithLruTimestamp<T>
where
    T: Default,
{
    #[inline]
    fn default() -> Self {
        WithLruTimestamp {
            timestamp: Cell::new(Instant::now()),
            inner: Default::default(),
        }
    }
}

impl<T> AsRef<T> for WithLruTimestamp<T> {
    #[inline]
    fn as_ref(&self) -> &T {
        &self.inner
    }
}

impl<T> AsMut<T> for WithLruTimestamp<T> {
    #[inline]
    fn as_mut(&mut self) -> &mut T {
        &mut self.inner
    }
}

impl<T> Deref for WithLruTimestamp<T> {
    type Target = T;

    #[inline]
    fn deref(&self) -> &T {
        &self.inner
    }
}

impl<T> DerefMut for WithLruTimestamp<T> {
    #[inline]
    fn deref_mut(&mut self) -> &mut T {
        &mut self.inner
    }
}

impl<T> From<T> for WithLruTimestamp<T> {
    #[inline]
    fn from(inner: T) -> WithLruTimestamp<T> {
        WithLruTimestamp::new(inner)
    }
}

impl<T> WithLruTimestamp<T> {
    /// Construct a new `WithLruTimestamp` wrapper around an inner value.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let inner = "hello!".to_string();
    /// let outer = WithLruTimestamp::new(inner);
    /// ```
    #[inline]
    pub fn new(inner: T) -> WithLruTimestamp<T> {
        WithLruTimestamp {
            timestamp: Cell::new(Instant::now()),
            inner,
        }
    }

    /// Recover the inner `T` value by consuming a `WithLruTimestamp<T>`.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let outer = WithLruTimestamp::new("hello!".to_string());
    /// let inner = WithLruTimestamp::into_inner(outer);
    /// assert_eq!(inner, "hello!");
    /// ```
    #[inline]
    pub fn into_inner(outer: WithLruTimestamp<T>) -> T {
        outer.inner
    }
}

impl<T> LruTimestamp for WithLruTimestamp<T> {
    type Timestamp<'a> = &'a Cell<Instant> where T: 'a;

    #[inline]
    fn get_timestamp(&self) -> Self::Timestamp<'_> {
        &self.timestamp
    }

    #[inline]
    fn update_timestamp(&self) {
        self.timestamp.set(Instant::now());
    }
}

/// Least recently used (LRU) cache replacement.
///
/// When considering which one of N cache values to replace, choose the one that
/// was least recently used.
///
/// Requires that the cache value type implement `LruTimestamp`.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LruReplacement {
    _private: (),
}

impl<V, C> Replacement<V, C> for LruReplacement
where
    C: Capacity,
    V: LruTimestamp,
{
    #[inline]
    fn choose_for_replacement<'a>(
        &mut self,
        candidates: impl ExactSizeIterator<Item = (usize, &'a V)>,
    ) -> usize
    where
        V: 'a,
    {
        let mut lru = None;
        for (index, value) in candidates {
            let timestamp = value.get_timestamp();
            lru = match lru {
                Some((t, i)) if t < timestamp => Some((t, i)),
                _ => Some((timestamp, index)),
            };
        }
        lru.unwrap().1
    }

    #[inline]
    fn on_hit(&self, value: &V) {
        value.update_timestamp();
    }

    #[inline]
    fn on_insert(&self, value: &V) {
        value.update_timestamp();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Capacity4;
    use std::time::Duration;

    #[test]
    fn lru_replacement() {
        let now = Instant::now();
        let candidates = vec![
            now,
            now - Duration::from_secs(1),
            now - Duration::from_secs(2),
            now - Duration::from_secs(3),
        ]
        .into_iter()
        .map(|t| WithLruTimestamp {
            timestamp: Cell::new(t),
            inner: (),
        })
        .collect::<Vec<_>>();

        let replacement = &mut LruReplacement::default();

        let index = <LruReplacement as Replacement<_, Capacity4>>::choose_for_replacement(
            replacement,
            candidates.iter().enumerate(),
        );

        assert_eq!(index, 3);
    }

    #[test]
    fn lru_timestamp_ref() {
        struct Wrap {
            timestamp: Instant,
        }
        impl LruTimestamp for Wrap {
            type Timestamp<'a> = &'a Instant;
            fn get_timestamp(&self) -> Self::Timestamp<'_> {
                &self.timestamp
            }
            fn update_timestamp(&self) {}
        }
        let now = Instant::now();
        let candidates = vec![
            now,
            now - Duration::from_secs(1),
            now - Duration::from_secs(2),
            now - Duration::from_secs(3),
        ]
        .into_iter()
        .map(|t| Wrap { timestamp: t })
        .collect::<Vec<_>>();

        let replacement = &mut LruReplacement::default();

        let index = <LruReplacement as Replacement<_, Capacity4>>::choose_for_replacement(
            replacement,
            candidates.iter().enumerate(),
        );

        assert_eq!(index, 3);
    }

    #[test]
    fn lru_timestamp_owned() {
        #[repr(packed)]
        struct Wrap {
            timestamp: Instant,
        }
        impl LruTimestamp for Wrap {
            type Timestamp<'a> = Instant;
            fn get_timestamp(&self) -> Self::Timestamp<'_> {
                self.timestamp
            }
            fn update_timestamp(&self) {}
        }
        let now = Instant::now();
        let candidates = vec![
            now,
            now - Duration::from_secs(1),
            now - Duration::from_secs(2),
            now - Duration::from_secs(3),
        ]
        .into_iter()
        .map(|t| Wrap { timestamp: t })
        .collect::<Vec<_>>();

        let replacement = &mut LruReplacement::default();

        let index = <LruReplacement as Replacement<_, Capacity4>>::choose_for_replacement(
            replacement,
            candidates.iter().enumerate(),
        );

        assert_eq!(index, 3);
    }
}
