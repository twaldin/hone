//! This crate provides a generic, fixed-size, N-way associative cache data
//! structure that supports random and least recently used replacement (or your
//! own custom algorithm).
//!
//! Dive into the documentation for [`AssociativeCache`] to begin.

#![deny(missing_docs, missing_debug_implementations)]

pub mod capacity;
pub mod entry;
pub mod indices;
pub mod iter;
pub mod replacement;

pub use capacity::*;
pub use entry::*;
pub use indices::*;
pub use iter::*;
pub use replacement::*;

use std::borrow::Borrow;
use std::cmp::max;
use std::marker::PhantomData;
use std::mem;

/// A constant cache capacity.
///
/// ## Provided `Capacity` Implementations
///
/// This crate defines all power-of-two capacities up to 8192 as
/// `associative_cache::CapacityN`.
///
/// ```
/// use associative_cache::Capacity256;
/// ```
///
/// ## Defining Custom Cache Capacities
///
/// You may implement this trait yourself to define your own custom cache
/// capacities:
///
/// ```
/// use associative_cache::Capacity;
///
/// pub struct Capacity42;
///
/// impl Capacity for Capacity42 {
///     const CAPACITY: usize = 42;
/// }
/// ```
pub trait Capacity {
    /// The constant capacity for a cache.
    ///
    /// Must be greater than zero.
    const CAPACITY: usize;
}

/// Given a cache key, return all the slots within the cache where its entry
/// might be.
///
/// ## Associativity
///
/// The associativity of a cache is how many slots in the cache a key might
/// reside in. There are generally many more possible values than there is
/// capacity in the cache. Allowing a entry to be in one of multiple slots
/// within the cache raises the cache hit rate, but takes a little extra time
/// when querying the cache because each of those multiple slots need to be
/// considered.
///
/// * **Direct-mapped:** A cache key corresponds to only one possible slot in
///   the cache.
///
/// * **Two-way:** A cache key corresponds to two possible slots in the cache.
///
/// * **Four-way:** A cache key corresponds to four possible slots in the cache.
///
/// * Etc...
///
/// [Wikipedia has more details on cache
/// associativity.](https://en.wikipedia.org/wiki/CPU_cache#Associativity)
///
/// ## Provided Implementations
///
/// This crate provides two flavors of associativity out of the box:
///
/// 1. `Hash`-based implementations: `HashDirectMapped` and
///    `Hash{Two,Four,Eight,Sixteen,ThirtyTwo}Way` provide various associativity
///    levels based on the key's `Hash` implementation.
///
/// 2. Pointer-based implementations: `PointerDirectMapped` and
///    `Pointer{Two,Four,Eight,Sixteen,ThirtyTwo}Way` provide various
///    associativity levels based on the pointer value, taking advantage of its
///    referenced type's alignment. This will generally provide faster lookups
///    than hashing, but is less general.
///
/// ## Custom Implementation Requirements
///
/// Implementations must be deterministic.
///
/// All indices yielded must be within the capacity.
///
/// The iterator must always be non-empty.
///
/// For example, to implement a two-way cache, return an iterator of two
/// indices.
pub trait Indices<K, C>
where
    K: ?Sized,
    C: Capacity,
{
    /// The iterator over indices within the range `0..C::CAPACITY` yielding the
    /// slots in the cache where the key's entry might reside.
    type Indices: ExactSizeIterator<Item = usize>;

    /// Get the indices within the range `0..C::CAPACITY` representing slots in
    /// the cache where the given key's entry might reside.
    fn indices(key: &K) -> Self::Indices;
}

/// Given that we need to replace a cache entry when inserting a new one, consider
/// each `(index, entry)` pair and return the index whose entry should be
/// replaced.
///
/// The given iterator will always be non-empty, and its indices will always be
/// within the capacity, assuming the `Indices` that this is paired with is
/// conformant.
pub trait Replacement<V, C: Capacity> {
    /// Choose which of the given cache entries will be replaced.
    fn choose_for_replacement<'a>(
        &mut self,
        candidates: impl ExactSizeIterator<Item = (usize, &'a V)>,
    ) -> usize
    where
        V: 'a;

    /// Called whenever an existing cache entry is hit.
    fn on_hit(&self, value: &V) {
        let _ = value;
    }

    /// Called whenever a new cache entry is inserted.
    fn on_insert(&self, value: &V) {
        let _ = value;
    }
}

/// A fixed-size associative cache mapping `K` keys to `V` values.
///
/// ## Capacity
///
/// The cache has a constant, fixed-size capacity which is controlled by the `C`
/// type parameter and the `Capacity` trait. The memory for the cache entries is
/// eagerly allocated once and never resized.
///
/// ## Associativity
///
/// The cache can be configured as direct-mapped, two-way associative, four-way
/// associative, etc... via the `I` type parameter and `Indices` trait.
///
/// ## Replacement Policy
///
/// Can be configured to replace the least-recently used entry, or a random
/// entry via the `R` type parameter and the `Replacement` trait.
///
/// ## Examples
///
/// ```
/// # #[cfg(feature = "rand")]
/// # {
/// use associative_cache::*;
///
/// // A two-way associative cache with random replacement mapping
/// // `String`s to `usize`s.
/// let cache = AssociativeCache::<
///     String,
///     usize,
///     Capacity512,
///     HashTwoWay,
///     RandomReplacement
/// >::default();
///
/// // A four-way associative cache with random replacement mapping
/// // `*mut usize`s to `Vec<u8>`s.
/// let cache = AssociativeCache::<
///     *mut usize,
///     Vec<u8>,
///     Capacity32,
///     PointerFourWay,
///     RandomReplacement
/// >::default();
///
/// // An eight-way associative, least recently used (LRU) cache mapping
/// // `std::path::PathBuf`s to `std::fs::File`s.
/// let cache = AssociativeCache::<
///     std::path::PathBuf,
///     WithLruTimestamp<std::fs::File>,
///     Capacity128,
///     HashEightWay,
///     LruReplacement,
/// >::default();
/// # }
/// ```
#[derive(Debug)]
pub struct AssociativeCache<K, V, C, I, R>
where
    C: Capacity,
    R: Replacement<V, C>,
{
    entries: Vec<Option<(K, V)>>,
    len: usize,
    replacement_policy: R,
    _capacity: PhantomData<C>,
    _indices: PhantomData<I>,
}

impl<K, V, C, I, R> Default for AssociativeCache<K, V, C, I, R>
where
    C: Capacity,
    R: Default + Replacement<V, C>,
{
    fn default() -> Self {
        AssociativeCache::with_replacement_policy(R::default())
    }
}

impl<K, V, C, I, R> AssociativeCache<K, V, C, I, R>
where
    C: Capacity,
    R: Replacement<V, C>,
{
    /// Construct an `AssociativeCache` with the given replacement policy.
    ///
    /// ## Example
    ///
    /// ```
    /// # #[cfg(feature = "rand")]
    /// # {
    /// use associative_cache::*;
    /// use rand::{rngs::StdRng, SeedableRng};
    /// use std::path::PathBuf;
    /// use std::fs::File;
    ///
    /// // Note: `RandomReplacement` requires the "rand" feature to be enabled.
    /// let policy = RandomReplacement::with_rng(StdRng::seed_from_u64(42));
    ///
    /// let cache = AssociativeCache::<
    ///     PathBuf,
    ///     File,
    ///     Capacity128,
    ///     HashEightWay,
    ///     _,
    /// >::with_replacement_policy(policy);
    /// # }
    /// ```
    pub fn with_replacement_policy(replacement_policy: R) -> Self {
        assert!(C::CAPACITY > 0);
        let mut entries = Vec::with_capacity(C::CAPACITY);
        for _ in 0..C::CAPACITY {
            entries.push(None);
        }
        AssociativeCache {
            entries,
            len: 0,
            replacement_policy,
            _capacity: PhantomData,
            _indices: PhantomData,
        }
    }

    /// Get a shared reference to this cache's replacement policy.
    #[inline]
    pub fn replacement_policy(&self) -> &R {
        &self.replacement_policy
    }

    /// Get an exclusive reference to this cache's replacement policy.
    #[inline]
    pub fn replacement_policy_mut(&mut self) -> &mut R {
        &mut self.replacement_policy
    }

    /// Get this cache's constant capacity, aka `C::CAPACITY`.
    #[inline]
    pub fn capacity(&self) -> usize {
        assert_eq!(self.entries.len(), C::CAPACITY);
        C::CAPACITY
    }

    /// Get the number of entries in this cache.
    ///
    /// This is always less than or equal to the capacity.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity16,
    ///     HashDirectMapped,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// // Initially, the cache is empty.
    /// assert_eq!(cache.len(), 0);
    ///
    /// let old_entry = cache.insert("hi".to_string(), 2);
    ///
    /// // We know the cache was empty, so there can't be an old entry that was
    /// // replaced.
    /// assert!(old_entry.is_none());
    ///
    /// // And now the length is 1.
    /// assert_eq!(cache.len(), 1);
    ///
    /// // Insert another entry. If this doesn't conflict with the existing
    /// // entry, then we should have a length of 2. If it did conflict, and we
    /// // replaced the old entry, then we should still have a length of 1.
    /// if cache.insert("bye".to_string(), 3).is_none() {
    ///     assert_eq!(cache.len(), 2);
    /// } else {
    ///     assert_eq!(cache.len(), 1);
    /// }
    /// ```
    #[inline]
    pub fn len(&self) -> usize {
        debug_assert!(self.len <= self.capacity());
        self.len
    }

    /// Return `true` if there are zero entries in the cache.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Insert a new entry into the cache.
    ///
    /// If there is an old entry for this key, or if another entry ends up
    /// getting replaced by this new one, return the old entry.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity1,
    ///     HashDirectMapped,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// // Insert an entry for "hi" into the cache.
    /// let old_entry = cache.insert("hi".to_string(), 42);
    ///
    /// // The cache was empty, so no old entry.
    /// assert!(old_entry.is_none());
    ///
    /// // Insert an entry for "bye" into the cache.
    /// let old_entry = cache.insert("bye".to_string(), 1337);
    ///
    /// // Because the cache only has a capacity of one, we replaced "hi" when
    /// // inserting "bye".
    /// assert_eq!(old_entry, Some(("hi".to_string(), 42)));
    /// ```
    pub fn insert(&mut self, key: K, value: V) -> Option<(K, V)>
    where
        I: Indices<K, C>,
        K: PartialEq,
    {
        let capacity = self.capacity();

        #[derive(Ord, PartialOrd, Eq, PartialEq)]
        enum InsertionCandidate {
            New(usize),
            Replace(usize),
        }
        assert!(None < Some(InsertionCandidate::New(0)));
        assert!(InsertionCandidate::New(0) < InsertionCandidate::Replace(0));

        // First see if we can insert the value to an existing entry for this
        // key, or without replaceing any other entry.
        let mut best = None;
        for index in I::indices(&key) {
            assert!(
                index < capacity,
                "`Indices::indices` must always yield indices within the capacity"
            );
            match self.entries[index] {
                None => {
                    best = max(best, Some(InsertionCandidate::New(index)));
                }
                Some((ref k, _)) if *k == key => {
                    best = max(best, Some(InsertionCandidate::Replace(index)));
                }
                _ => continue,
            }
        }

        match best {
            None => {}
            Some(InsertionCandidate::New(index)) => {
                self.entries[index] = Some((key, value));
                self.len += 1;
                return None;
            }
            Some(InsertionCandidate::Replace(index)) => {
                return mem::replace(&mut self.entries[index], Some((key, value)));
            }
        }

        // Okay, we have to replace an entry. Let the `ReplacementPolicy` decide
        // which one.
        let AssociativeCache {
            ref entries,
            ref mut replacement_policy,
            ..
        } = self;
        let candidates = I::indices(&key).map(|index| {
            assert!(
                index < capacity,
                "`I::indices` must always yield indices within the capacity"
            );
            let value = &entries[index]
                .as_ref()
                // We know that all the indices we saw above are full, so the
                // only way this `expect` would fail is if `Indices::indices` is
                // non-deterministic.
                .expect(
                    "`Indices::indices` must always yield the same indices for the same entries",
                )
                .1;
            (index, value)
        });
        let index = replacement_policy.choose_for_replacement(candidates);
        debug_assert!(
            I::indices(&key).any(|i| i == index),
            "`ReplacementPolicy::choose_for_replacement` must return a candidate index"
        );
        assert!(index < capacity);
        assert!(self.entries[index].is_some());
        mem::replace(&mut self.entries[index], Some((key, value)))
    }

    /// Get a shared reference to the value for a given key, if it exists in the
    /// cache.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity1,
    ///     HashDirectMapped,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// // Returns `None` if there is no cache entry for the key.
    /// assert!(cache.get("hi").is_none());
    ///
    /// cache.insert("hi".to_string(), 1234);
    ///
    /// // Otherwise, returns the value if there is an entry for the key.
    /// assert_eq!(cache.get("hi"), Some(&1234));
    /// ```
    #[inline]
    pub fn get<Q>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        I: Indices<Q, C>,
        Q: ?Sized + PartialEq,
    {
        assert_eq!(self.entries.len(), C::CAPACITY);

        for index in I::indices(key) {
            assert!(
                index < self.entries.len(),
                "`Indices::indices` must always yield indices within the capacity"
            );
            match &self.entries[index] {
                Some((k, v)) if k.borrow() == key => {
                    self.replacement_policy.on_hit(v);
                    return Some(v);
                }
                _ => continue,
            }
        }

        None
    }

    /// Get an exclusive reference to the value for a given key, if it exists in
    /// the cache.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity1,
    ///     HashDirectMapped,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// // Returns `None` if there is no cache entry for the key.
    /// assert!(cache.get_mut("hi").is_none());
    ///
    /// cache.insert("hi".to_string(), 1234);
    ///
    /// // Otherwise, returns the value if there is an entry for the key.
    /// let val = cache.get_mut("hi").unwrap();
    /// assert_eq!(*val, 1234);
    ///
    /// // And we can assign to the cache value.
    /// *val = 5678;
    /// ```
    #[inline]
    pub fn get_mut<Q>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
        I: Indices<Q, C>,
        Q: ?Sized + PartialEq,
    {
        assert_eq!(self.entries.len(), C::CAPACITY);

        for index in I::indices(key) {
            assert!(
                index < C::CAPACITY,
                "`Indices::indices` must always yield indices within the capacity"
            );
            match &self.entries[index] {
                Some((k, _)) if k.borrow() == key => {
                    let v = &mut self.entries[index].as_mut().unwrap().1;
                    self.replacement_policy.on_hit(v);
                    return Some(v);
                }
                _ => continue,
            }
        }

        None
    }

    /// Remove an entry from the cache.
    ///
    /// If an entry for the key existed in the cache, it is removed and `Some`
    /// is returned. Otherwise, `None` is returned.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity1,
    ///     HashDirectMapped,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// // Returns `None` if there is no cache entry for the key and therefore
    /// // nothing was removed.
    /// assert!(cache.remove("hi").is_none());
    ///
    /// cache.insert("hi".to_string(), 1234);
    ///
    /// // Otherwise, returns the value that was removed if there was an entry
    /// // for the key.
    /// assert_eq!(cache.remove("hi"), Some(1234));
    /// ```
    #[inline]
    pub fn remove<Q>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        I: Indices<Q, C>,
        Q: ?Sized + PartialEq,
    {
        assert_eq!(self.entries.len(), C::CAPACITY);

        for index in I::indices(key) {
            assert!(
                index < self.entries.len(),
                "`Indices::indices` must always yield indices within the capacity"
            );
            match &self.entries[index] {
                Some((k, _)) if k.borrow() == key => {
                    self.len -= 1;
                    return self.entries[index].take().map(|(_, v)| v);
                }
                _ => continue,
            }
        }

        None
    }

    /// Retain only the cache entries specified by the predicate.
    ///
    /// Calls `f` with each entry in the cache, and removes all entries where
    /// `f` returned false.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     char,
    ///     usize,
    ///     Capacity8,
    ///     HashDirectMapped,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// for (i, ch) in "I let my tape rock, 'til my tape popped".char_indices() {
    ///     cache.insert(ch, i);
    /// }
    ///
    /// for (key, val) in cache.iter() {
    ///     println!("Last saw character '{}' at index {}", key, val);
    /// }
    /// ```
    pub fn retain(&mut self, mut f: impl FnMut(&K, &mut V) -> bool) {
        for e in &mut self.entries {
            if let Some((k, v)) = e {
                if !f(k, v) {
                    *e = None;
                    self.len -= 1;
                }
            }
        }
    }

    /// Get the key's corresponding slot within the cache for in-place mutation
    /// and performing get-or-create operations.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity4,
    ///     HashTwoWay,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// for word in "she sells sea shells down by the sea shore".split_whitespace() {
    ///     let count = cache.entry(word).or_insert_with(
    ///         || word.to_string(),
    ///         || 0,
    ///     );
    ///     *count += 1;
    /// }
    /// ```
    #[inline]
    pub fn entry<Q>(&mut self, key: &Q) -> Entry<'_, K, V, C, I, R>
    where
        K: Borrow<Q>,
        I: Indices<Q, C>,
        Q: ?Sized + PartialEq,
    {
        let capacity = self.capacity();

        // First, see if we have an entry for this key, or if we have an empty
        // slot where an entry could be placed without replaceing another entry.
        let mut empty_index = None;
        for index in I::indices(key) {
            assert!(
                index < capacity,
                "`Indices::indices` must always yield indices within the capacity"
            );
            match &mut self.entries[index] {
                None => {
                    empty_index = Some(index);
                }
                Some((k, v)) if (*k).borrow() == key => {
                    self.replacement_policy.on_hit(v);
                    return Entry {
                        cache: self,
                        kind: EntryKind::Occupied,
                        index,
                    };
                }
                _ => continue,
            }
        }
        if let Some(index) = empty_index {
            return Entry {
                cache: self,
                kind: EntryKind::Vacant,
                index,
            };
        }

        // Okay, we have to return an already-in-use entry, which will be
        // replaced if the user inserts anything.
        let AssociativeCache {
            ref entries,
            ref mut replacement_policy,
            ..
        } = self;
        let candidates = I::indices(key).map(|index| {
            assert!(
                index < capacity,
                "`I::indices` must always yield indices within the capacity"
            );
            let value = &entries[index]
                .as_ref()
                // We know that all the indices we saw above are full, so the
                // only way this `expect` would fail is if `Indices::indices` is
                // non-deterministic.
                .expect(
                    "`Indices::indices` must always yield the same indices for the same entries",
                )
                .1;
            (index, value)
        });
        let index = replacement_policy.choose_for_replacement(candidates);
        Entry {
            cache: self,
            kind: EntryKind::Replace,
            index,
        }
    }

    /// Iterate over shared references to this cache's keys and values.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity4,
    ///     HashTwoWay,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// // First, insert some entries into the cache. Note that this is more
    /// // entries than the cache has capacity for.
    /// for s in vec!["red", "blue", "green", "pink", "purple", "orange"] {
    ///     cache.insert(s.to_string(), s.len());
    /// }
    ///
    /// // Now iterate over the entries that are still in the cache:
    /// for (k, v) in cache.iter() {
    ///     println!("{} -> {}", k, v);
    /// }
    /// ```
    #[inline]
    pub fn iter(&self) -> Iter<'_, K, V> {
        <&Self as IntoIterator>::into_iter(self)
    }

    /// Iterate over shared references to this cache's keys and exclusive
    /// references to its values.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity4,
    ///     HashTwoWay,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// // First, insert some entries into the cache. Note that this is more
    /// // entries than the cache has capacity for.
    /// for s in vec!["red", "blue", "green", "pink", "purple", "orange"] {
    ///     cache.insert(s.to_string(), s.len());
    /// }
    ///
    /// // Now iterate over the entries that are still in the cache and mutate
    /// // them:
    /// for (k, v) in cache.iter_mut() {
    ///     println!("{} was {}...", k, v);
    ///     *v += 1;
    ///     println!("...but now it's {}!", v);
    /// }
    /// ```
    #[inline]
    pub fn iter_mut(&mut self) -> IterMut<'_, K, V> {
        <&mut Self as IntoIterator>::into_iter(self)
    }

    /// Consume this cache, and iterate over its keys and values.
    ///
    /// ## Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity4,
    ///     HashTwoWay,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// // First, insert some entries into the cache. Note that this is more
    /// // entries than the cache has capacity for.
    /// for s in vec!["red", "blue", "green", "pink", "purple", "orange"] {
    ///     cache.insert(s.to_string(), s.len());
    /// }
    ///
    /// // Not possible with `iter` or `iter_mut` without cloning.
    /// let v: Vec<(String, usize)> = cache.into_iter().collect();
    /// ```
    #[inline]
    #[allow(clippy::should_implement_trait)]
    pub fn into_iter(self) -> IntoIter<K, V> {
        <Self as IntoIterator>::into_iter(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_policy() {
        let mut policy = RoundRobinReplacement::default();
        let mut cache = AssociativeCache::<usize, usize, Capacity4, HashDirectMapped,_>::with_replacement_policy(policy.clone());
        assert_eq!(cache.replacement_policy(), &policy);
        assert_eq!(cache.replacement_policy_mut(), &mut policy);
    }

    #[test]
    fn capacity() {
        let cache = AssociativeCache::<
            usize,
            usize,
            Capacity2,
            HashDirectMapped,
            RoundRobinReplacement,
        >::default();
        assert_eq!(cache.capacity(), 2);

        let cache = AssociativeCache::<
            usize,
            usize,
            Capacity4,
            HashDirectMapped,
            RoundRobinReplacement,
        >::default();
        assert_eq!(cache.capacity(), 4);

        let cache = AssociativeCache::<
            usize,
            usize,
            Capacity8,
            HashDirectMapped,
            RoundRobinReplacement,
        >::default();
        assert_eq!(cache.capacity(), 8);
    }

    #[test]
    fn len() {
        let mut cache = AssociativeCache::<
            usize,
            usize,
            Capacity512,
            HashDirectMapped,
            RoundRobinReplacement,
        >::default();

        assert_eq!(cache.insert(1, 2), None);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.insert(3, 4), None);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.insert(5, 6), None);
        assert_eq!(cache.len(), 3);

        cache.insert(1, 7).unwrap();
        assert_eq!(cache.len(), 3);
        cache.insert(3, 8).unwrap();
        assert_eq!(cache.len(), 3);
        cache.insert(5, 9).unwrap();
        assert_eq!(cache.len(), 3);
    }

    #[test]
    fn insert() {
        let mut cache = AssociativeCache::<
            *mut u8,
            usize,
            Capacity4,
            PointerTwoWay,
            RoundRobinReplacement,
        >::default();

        // Fill all the cache slots.
        assert_eq!(cache.insert(0 as *mut u8, 0), None);
        assert_eq!(cache.insert(1 as *mut u8, 1), None);
        assert_eq!(cache.insert(2 as *mut u8, 2), None);
        assert_eq!(cache.insert(3 as *mut u8, 3), None);

        // Start replacing old entries with new insertions.
        assert_eq!(cache.insert(4 as *mut u8, 4), Some((2 as *mut u8, 2)));
        assert_eq!(cache.insert(6 as *mut u8, 6), Some((0 as *mut u8, 0)));
        assert_eq!(cache.insert(5 as *mut u8, 5), Some((3 as *mut u8, 3)));
        assert_eq!(cache.insert(7 as *mut u8, 7), Some((1 as *mut u8, 1)));
    }

    #[test]
    fn get() {
        let mut cache = AssociativeCache::<
            *mut u8,
            usize,
            Capacity4,
            PointerTwoWay,
            RoundRobinReplacement,
        >::default();

        cache.insert(0 as *mut _, 0);
        assert_eq!(cache.get(&(0 as *mut _)), Some(&0));
        assert_eq!(cache.get(&(1 as *mut _)), None);

        cache.insert(4 as *mut _, 4);
        assert_eq!(cache.get(&(0 as *mut _)), Some(&0));
        assert_eq!(cache.get(&(4 as *mut _)), Some(&4));
        assert_eq!(cache.get(&(1 as *mut _)), None);

        assert_eq!(cache.insert(8 as *mut _, 8), Some((4 as *mut _, 4)));
        assert_eq!(cache.get(&(0 as *mut _)), Some(&0));
        assert_eq!(cache.get(&(8 as *mut _)), Some(&8));
        assert_eq!(cache.get(&(1 as *mut _)), None);
    }

    #[test]
    fn get_mut() {
        let mut cache = AssociativeCache::<
            *mut u8,
            usize,
            Capacity4,
            PointerTwoWay,
            RoundRobinReplacement,
        >::default();

        cache.insert(0 as *mut _, 0);
        assert_eq!(cache.get_mut(&(0 as *mut _)), Some(&mut 0));
        assert_eq!(cache.get_mut(&(1 as *mut _)), None);

        cache.insert(4 as *mut _, 4);
        assert_eq!(cache.get_mut(&(0 as *mut _)), Some(&mut 0));
        assert_eq!(cache.get_mut(&(4 as *mut _)), Some(&mut 4));
        assert_eq!(cache.get_mut(&(1 as *mut _)), None);

        assert_eq!(cache.insert(8 as *mut _, 8), Some((4 as *mut _, 4)));
        assert_eq!(cache.get_mut(&(0 as *mut _)), Some(&mut 0));
        assert_eq!(cache.get_mut(&(8 as *mut _)), Some(&mut 8));
        assert_eq!(cache.get_mut(&(1 as *mut _)), None);
    }

    #[test]
    fn remove() {
        let mut cache = AssociativeCache::<
            *mut u8,
            usize,
            Capacity4,
            PointerTwoWay,
            RoundRobinReplacement,
        >::default();

        cache.insert(0 as *mut _, 0);
        cache.insert(4 as *mut _, 4);
        assert_eq!(cache.len(), 2);

        assert_eq!(cache.remove(&(4 as *mut _)), Some(4));
        assert_eq!(cache.remove(&(4 as *mut _)), None);
        assert_eq!(cache.remove(&(0 as *mut _)), Some(0));
        assert_eq!(cache.remove(&(0 as *mut _)), None);
    }

    #[test]
    fn retain() {
        let mut cache = AssociativeCache::<
            *mut u8,
            usize,
            Capacity4,
            PointerTwoWay,
            RoundRobinReplacement,
        >::default();

        cache.insert(0 as *mut _, 0);
        cache.insert(1 as *mut _, 1);
        cache.insert(2 as *mut _, 2);
        cache.insert(3 as *mut _, 3);
        assert_eq!(cache.len(), 4);

        cache.retain(|_, v| *v % 2 == 0);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get(&(0 as *mut _)), Some(&0));
        assert_eq!(cache.get(&(1 as *mut _)), None);
        assert_eq!(cache.get(&(2 as *mut _)), Some(&2));
        assert_eq!(cache.get(&(3 as *mut _)), None);
    }

    #[test]
    fn entry() {
        let mut cache = AssociativeCache::<
            *mut u8,
            usize,
            Capacity1,
            PointerDirectMapped,
            RoundRobinReplacement,
        >::default();

        // Vacant
        assert_eq!(
            cache
                .entry(&(0 as *mut _))
                .or_insert_with(|| 0 as *mut _, || 0),
            &mut 0
        );
        assert_eq!(cache.len(), 1);

        // Occupied
        assert_eq!(
            cache
                .entry(&(0 as *mut _))
                .or_insert_with(|| unreachable!(), || unreachable!()),
            &mut 0
        );
        assert_eq!(cache.len(), 1);

        // Replace
        let mut entry = cache.entry(&(1 as *mut _));
        assert_eq!(
            entry.take_entry_that_will_be_replaced(),
            Some((0 as *mut _, 0))
        );
        assert_eq!(entry.or_insert_with(|| 1 as *mut _, || 1), &mut 1);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn iter() {
        let mut cache = AssociativeCache::<
            *mut u8,
            usize,
            Capacity4,
            PointerDirectMapped,
            RoundRobinReplacement,
        >::default();

        cache.insert(0 as *mut _, 0);
        cache.insert(1 as *mut _, 1);
        cache.insert(2 as *mut _, 2);
        cache.insert(3 as *mut _, 3);
        assert_eq!(cache.len(), 4);

        let mut seen = vec![false; 4];
        for (&k, &v) in &cache {
            assert!(!seen[v]);
            seen[v] = true;
            assert_eq!(k as usize, v);
        }
        assert!(seen.iter().all(|&b| b));
    }

    #[test]
    fn iter_mut() {
        let mut cache = AssociativeCache::<
            *mut u8,
            usize,
            Capacity4,
            PointerDirectMapped,
            RoundRobinReplacement,
        >::default();

        cache.insert(0 as *mut _, 0);
        cache.insert(1 as *mut _, 1);
        cache.insert(2 as *mut _, 2);
        cache.insert(3 as *mut _, 3);
        assert_eq!(cache.len(), 4);

        let mut seen = vec![false; 4];
        for (&k, v) in &mut cache {
            assert!(!seen[*v]);
            seen[*v] = true;
            assert_eq!(k as usize, *v);
            *v += 1;
        }
        assert!(seen.iter().all(|&b| b));

        assert_eq!(cache.get(&(0 as *mut _)), Some(&1));
        assert_eq!(cache.get(&(1 as *mut _)), Some(&2));
        assert_eq!(cache.get(&(2 as *mut _)), Some(&3));
        assert_eq!(cache.get(&(3 as *mut _)), Some(&4));
    }

    #[test]
    fn into_iter() {
        let mut cache = AssociativeCache::<
            *mut u8,
            usize,
            Capacity4,
            PointerDirectMapped,
            RoundRobinReplacement,
        >::default();

        cache.insert(0 as *mut _, 0);
        cache.insert(1 as *mut _, 1);
        cache.insert(2 as *mut _, 2);
        cache.insert(3 as *mut _, 3);
        assert_eq!(cache.len(), 4);

        let mut seen = vec![false; 4];
        for (k, v) in cache {
            assert!(!seen[v]);
            seen[v] = true;
            assert_eq!(k as usize, v);
        }
        assert!(seen.iter().all(|&b| b));
    }
}
