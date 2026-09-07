//! An API for get-or-create operations on cache entries, similar to
//! `std::collections::HashMap`'s entry API.

use super::*;
use std::fmt;

/// A potentially-empty entry in a cache, used to perform get-or-create
/// operations on the cache.
///
/// Constructed via the `AssociativeCache::entry` method.
pub struct Entry<'a, K, V, C, I, R>
where
    C: Capacity,
    R: Replacement<V, C>,
{
    pub(crate) cache: &'a mut AssociativeCache<K, V, C, I, R>,
    pub(crate) index: usize,
    pub(crate) kind: EntryKind,
}

impl<'a, K, V, C, I, R> fmt::Debug for Entry<'a, K, V, C, I, R>
where
    C: Capacity,
    R: Replacement<V, C>,
{
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let Entry {
            cache: _,
            ref index,
            ref kind,
        } = self;
        f.debug_struct("Entry")
            .field("index", index)
            .field("kind", kind)
            .finish()
    }
}

#[derive(Debug)]
pub(crate) enum EntryKind {
    // The index is occupied with a cache entry for this key.
    Occupied,
    // The index is for a slot that has no entry in it.
    Vacant,
    // The index is for a slot that has a to-be-replaced entry for a
    // different key.
    Replace,
}

impl<'a, K, V, C, I, R> Entry<'a, K, V, C, I, R>
where
    C: Capacity,
    I: Indices<K, C>,
    R: Replacement<V, C>,
{
    /// Get the underlying cached data, creating and inserting it into the cache
    /// if it doesn't already exist.
    ///
    /// ## Differences from `std::collections::HashMap`'s `Entry` API
    ///
    /// `std::collections::HashMap`'s `Entry` API takes unconditional ownership
    /// of the query key, even in scenarios where there is already an entry with
    /// that key in the map. This means that if your keys are expensive to
    /// create (like `String` and its heap allocation) that you have to eagerly
    /// construct the key even if you don't end up needing it.
    ///
    /// In contrast, the `associative_cache::Entry` API allows you to get an
    /// `Entry` with just a borrow of a key, allowing you to delay the
    /// potentially-expensive key construction until we actually need
    /// it. However, this is not without drawbacks. Now the `or_insert_with`
    /// method needs a way to construct an owned key: the `make_key` parameter
    /// here. **`make_key` must return an owned key that is equivalent to the
    /// borrowed key that was used to get this `Entry`.** Failure to do this
    /// will result in an invalid cache (likely manifesting as wasted entries
    /// that take up space but can't ever be queried for).
    ///
    /// # Example
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
    /// // Get or create an entry for "hi", delaying the `&str` to `String`
    /// // allocation until if/when we actually insert into the cache.
    /// let val = cache.entry("hi").or_insert_with(
    ///     || "hi".to_string(),
    ///     || 42,
    /// );
    ///
    /// // The cache was empty, so we inserted the default value of 42.
    /// assert_eq!(*val, 42);
    ///
    /// // We can modify the value.
    /// *val += 1;
    /// ```
    #[inline]
    pub fn or_insert_with(
        self,
        make_key: impl FnOnce() -> K,
        make_val: impl FnOnce() -> V,
    ) -> &'a mut V {
        assert!(self.index < C::CAPACITY);
        match self.kind {
            EntryKind::Occupied => match &mut self.cache.entries[self.index] {
                Some((_, v)) => v,
                _ => unreachable!(),
            },
            EntryKind::Vacant | EntryKind::Replace => {
                if let EntryKind::Vacant = self.kind {
                    self.cache.len += 1;
                }
                self.cache.entries[self.index] = Some((make_key(), make_val()));
                match &mut self.cache.entries[self.index] {
                    Some((_, v)) => {
                        self.cache.replacement_policy.on_insert(v);
                        v
                    }
                    _ => unreachable!(),
                }
            }
        }
    }

    /// If inserting into this `Entry` will replace another entry in the
    /// cache, remove that other entry from the cache and return it now.
    ///
    /// # Example
    ///
    /// ```
    /// use associative_cache::*;
    ///
    /// let mut cache = AssociativeCache::<
    ///     String,
    ///     usize,
    ///     Capacity256,
    ///     HashTwoWay,
    ///     RoundRobinReplacement,
    /// >::default();
    ///
    /// cache.insert("hi".to_string(), 5);
    ///
    /// let mut entry = cache.entry("bye");
    ///
    /// // Because this entry could replace the entry for "hi" depending on the hash
    /// // function in use, we have an opportunity to recover the
    /// // about-to-be-replaced entry here.
    /// if let Some((key, val)) = entry.take_entry_that_will_be_replaced() {
    ///     assert_eq!(key, "hi");
    ///     assert_eq!(val, 5);
    /// }
    ///
    /// let val = entry.or_insert_with(|| "bye".into(), || 1337);
    /// assert_eq!(*val, 1337);
    /// ```
    #[inline]
    pub fn take_entry_that_will_be_replaced(&mut self) -> Option<(K, V)> {
        assert!(self.index < C::CAPACITY);
        if let EntryKind::Replace = self.kind {
            self.cache.len -= 1;
            self.kind = EntryKind::Vacant;
            mem::replace(&mut self.cache.entries[self.index], None)
        } else {
            None
        }
    }
}
