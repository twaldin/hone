//! Various iterator implementations and type definitions for
//! `AssociativeCache`.

use super::*;

impl<'a, K, V, C, I, R> IntoIterator for &'a AssociativeCache<K, V, C, I, R>
where
    C: Capacity,
    R: Replacement<V, C>,
{
    type Item = (&'a K, &'a V);
    type IntoIter = Iter<'a, K, V>;

    #[inline]
    fn into_iter(self) -> Self::IntoIter {
        Iter {
            len: self.len(),
            inner: self.entries.iter(),
        }
    }
}

impl<'a, K, V, C, I, R> IntoIterator for &'a mut AssociativeCache<K, V, C, I, R>
where
    C: Capacity,
    R: Replacement<V, C>,
{
    type Item = (&'a K, &'a mut V);
    type IntoIter = IterMut<'a, K, V>;

    #[inline]
    fn into_iter(self) -> Self::IntoIter {
        IterMut {
            len: self.len(),
            inner: self.entries.iter_mut(),
        }
    }
}

impl<K, V, C, I, R> IntoIterator for AssociativeCache<K, V, C, I, R>
where
    C: Capacity,
    R: Replacement<V, C>,
{
    type Item = (K, V);
    type IntoIter = IntoIter<K, V>;

    #[inline]
    fn into_iter(self) -> Self::IntoIter {
        IntoIter {
            len: self.len(),
            inner: self.entries.into_iter(),
        }
    }
}

/// An iterator over shared borrows of the cache keys and values.
///
/// See `AssociativeCache::iter` for details.
#[derive(Debug)]
pub struct Iter<'a, K, V> {
    len: usize,
    inner: std::slice::Iter<'a, Option<(K, V)>>,
}

impl<'a, K, V> Iterator for Iter<'a, K, V> {
    type Item = (&'a K, &'a V);

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            match self.inner.next() {
                None => return None,
                Some(None) => continue,
                Some(Some((k, v))) => {
                    debug_assert!(self.len > 0);
                    self.len -= 1;
                    return Some((k, v));
                }
            }
        }
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.len, Some(self.len))
    }
}

impl<K, V> ExactSizeIterator for Iter<'_, K, V> {}

/// An iterator over shared borrows of the cache keys and mutable borrows of the
/// cache values.
///
/// See `AssociativeCache::iter_mut` for details.
#[derive(Debug)]
pub struct IterMut<'a, K, V> {
    len: usize,
    inner: std::slice::IterMut<'a, Option<(K, V)>>,
}

impl<'a, K, V> Iterator for IterMut<'a, K, V> {
    type Item = (&'a K, &'a mut V);

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            match self.inner.next() {
                None => return None,
                Some(None) => continue,
                Some(Some((k, v))) => {
                    debug_assert!(self.len > 0);
                    self.len -= 1;
                    return Some((k, v));
                }
            }
        }
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.len, Some(self.len))
    }
}

impl<K, V> ExactSizeIterator for IterMut<'_, K, V> {}

/// An iterator that consumes and takes ownership of a cache's keys and values.
///
/// See `AssociativeCache::into_iter` for details.
#[derive(Debug)]
pub struct IntoIter<K, V> {
    len: usize,
    inner: std::vec::IntoIter<Option<(K, V)>>,
}

impl<K, V> Iterator for IntoIter<K, V> {
    type Item = (K, V);

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            match self.inner.next() {
                None => return None,
                Some(None) => continue,
                Some(Some(x)) => {
                    debug_assert!(self.len > 0);
                    self.len -= 1;
                    return Some(x);
                }
            }
        }
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.len, Some(self.len))
    }
}

impl<K, V> ExactSizeIterator for IntoIter<K, V> {}
