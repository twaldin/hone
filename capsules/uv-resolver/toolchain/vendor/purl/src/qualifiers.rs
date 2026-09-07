//! Specialized key-value collection for PURL qualifiers.

use std::cmp::Ordering;
use std::marker::PhantomData;
use std::ops::{Deref, Index, IndexMut};
use std::{mem, slice};

use self::well_known::KnownQualifierKey;
use crate::{ParseError, SmallString};

pub mod well_known;

/// A list of qualifiers.
///
/// Internally, qualifiers are stored as a sorted list of key-value pairs, ready
/// to be joined into a properly formatted PURL string.
///
/// The keys are always valid qualifier names in their canonical format
/// (lowercase). Uppercase keys are automatically converted to lowercase.
#[derive(Clone, Debug, Default, Eq, Hash, PartialEq, PartialOrd, Ord)]
pub struct Qualifiers {
    qualifiers: Vec<(QualifierKey, SmallString)>,
}

impl Qualifiers {
    /// Try to construct a [`Qualifiers`] list from key-value pairs.
    ///
    /// If any of the keys cannot be converted to a qualifier name,
    /// [`ParseError::InvalidQualifier`] will be returned.
    ///
    /// If the same key is repeated, [`ParseError::InvalidQualifier`] will be
    /// returned.
    pub fn try_from_iter<I, K, V>(items: I) -> Result<Self, ParseError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
        SmallString: From<K> + From<V>,
    {
        let items = items.into_iter();
        let mut this = Qualifiers::with_capacity(items.size_hint().0);
        for (key, value) in items {
            match this.entry(key)? {
                Entry::Occupied(_) => return Err(ParseError::InvalidQualifier),
                Entry::Vacant(entry) => {
                    entry.insert(value);
                },
            }
        }
        Ok(this)
    }

    /// Create an empty [`Qualifiers`] list with space for `capacity` elements.
    pub fn with_capacity(capacity: usize) -> Self {
        let mut this = Self::default();
        this.reserve_exact(capacity);
        this
    }

    /// Get the total capacity of the list.
    pub fn capacity(&self) -> usize {
        self.qualifiers.capacity()
    }

    /// Iterate over the elements of the list.
    pub fn iter(&self) -> Iter {
        Iter(self.qualifiers.iter())
    }

    /// Iterate over the elements of the list.
    ///
    /// Only the value may be mutated.
    pub fn iter_mut(&mut self) -> IterMut {
        IterMut(self.qualifiers.iter_mut())
    }

    /// Get the length of the list.
    pub fn len(&self) -> usize {
        self.qualifiers.len()
    }

    /// Check if the list is empty.
    pub fn is_empty(&self) -> bool {
        self.qualifiers.is_empty()
    }

    /// Remove all elements from the list.
    pub fn clear(&mut self) {
        self.qualifiers.clear()
    }

    /// Ensure the list has capacity for at least `additional` more elements.
    ///
    /// Compared to [`Self::reserve_exact`], if the capacity needs to be
    /// increased, this function may increase the capacity by more than the
    /// requested amount in order to have room for additional elements that
    /// may come later.
    pub fn reserve(&mut self, additional: usize) {
        self.qualifiers.reserve(additional)
    }

    /// Ensure the list has capacity for at least `additional` more elements.
    ///
    /// Compared to [`Self::reserve`], if the capacity needs to be increased,
    /// this function increases the capacity by the minimum number of
    /// elements to reach the desired capacity.
    pub fn reserve_exact(&mut self, additional: usize) {
        self.qualifiers.reserve_exact(additional)
    }

    /// Get a qualifier by key.
    ///
    /// If the qualifier is not in the list, `None` is returned.
    pub fn get<K>(&self, key: K) -> Option<&str>
    where
        K: AsRef<str>,
    {
        self.get_index(key).map(|i| self.qualifiers[i].1.as_str())
    }

    /// Get a typed qualifier.
    ///
    /// If the qualifier is not in the list, `None` is returned.
    pub fn get_typed<'a, Q>(&'a self) -> Option<Q>
    where
        Q: From<&'a str> + KnownQualifierKey,
    {
        self.get(Q::KEY).map(Q::from)
    }

    /// Try to get a typed qualifier.
    ///
    /// If the qualifier is not in the list, `Ok(None)` is returned.
    pub fn try_get_typed<'a, Q>(&'a self) -> Result<Option<Q>, Q::Error>
    where
        Q: TryFrom<&'a str> + KnownQualifierKey,
    {
        self.get(Q::KEY).map(Q::try_from).transpose()
    }

    fn get_index<K>(&self, key: K) -> Option<usize>
    where
        K: AsRef<str>,
    {
        // If it's not valid, it has no index.
        let key = check_qualifier_key(key).ok()?;
        self.search(&key).ok()
    }

    fn search<K>(&self, key: &MixedQualifierKey<K>) -> Result<usize, usize>
    where
        K: AsRef<str>,
    {
        self.qualifiers.binary_search_by(|(qk, _qv)| qk.partial_cmp(&key).unwrap())
    }

    /// Get an [`Entry`] for a qualifier.
    ///
    /// This allows obtaining the current value and modifying it or inserting a
    /// new value without needing to search for the qualifier multiple
    /// times.
    pub fn entry<K>(&mut self, key: K) -> Result<Entry<K>, ParseError>
    where
        K: AsRef<str>,
    {
        let key = check_qualifier_key(key)?;
        Ok(match self.search(&key) {
            Ok(index) => Entry::Occupied(OccupiedEntry {
                qualifiers: &mut self.qualifiers,
                index,
                key: PhantomData,
            }),
            Err(index) => {
                Entry::Vacant(VacantEntry { qualifiers: &mut self.qualifiers, index, key })
            },
        })
    }

    /// Get a qualifier.
    pub fn get_mut<K>(&mut self, key: K) -> Option<&mut SmallString>
    where
        K: AsRef<str>,
    {
        match self.entry(key) {
            Ok(Entry::Occupied(o)) => Some(o.into_mut()),
            _ => None,
        }
    }

    /// Check whether a qualifier with the given name exists.
    pub fn contains_key<K>(&self, key: K) -> bool
    where
        K: AsRef<str>,
    {
        self.get_index(key).is_some()
    }

    /// Check whether a qualifier with the given name exists.
    pub fn contains_typed<Q>(&self) -> bool
    where
        Q: KnownQualifierKey,
    {
        self.contains_key(Q::KEY)
    }

    /// Set a qualifier.
    pub fn insert<K, V>(&mut self, key: K, v: V) -> Result<&mut SmallString, ParseError>
    where
        K: AsRef<str>,
        SmallString: From<K> + From<V>,
    {
        let key = check_qualifier_key(key)?;
        let index = match self.search(&key) {
            Ok(i) => {
                self.qualifiers[i].1 = SmallString::from(v);
                i
            },
            Err(i) => {
                self.qualifiers.insert(i, (key.into_key(), SmallString::from(v)));
                i
            },
        };
        Ok(&mut self.qualifiers[index].1)
    }

    /// Set a typed qualifier.
    ///
    /// # Panics
    ///
    /// This method panics if the [`KnownQualifierKey::KEY`] is not a valid
    /// qualifier key.
    pub fn insert_typed<Q>(&mut self, value: Q)
    where
        Q: KnownQualifierKey,
        SmallString: From<Q>,
    {
        // Rust 1.68.1 gets confused without this type annotation.
        self.insert::<&'static str, _>(Q::KEY, value).unwrap();
    }

    /// Set a typed qualifier.
    ///
    /// # Panics
    ///
    /// This method panics if the [`KnownQualifierKey::KEY`] is not a valid
    /// qualifier key.
    pub fn try_insert_typed<Q>(
        &mut self,
        value: Q,
    ) -> Result<(), <SmallString as TryFrom<Q>>::Error>
    where
        Q: KnownQualifierKey,
        SmallString: TryFrom<Q>,
    {
        let value = SmallString::try_from(value)?;
        self.insert(Q::KEY, value).unwrap();
        Ok(())
    }

    /// Unset a qualifier.
    pub fn remove<S>(&mut self, key: S) -> Option<SmallString>
    where
        S: AsRef<str>,
    {
        if let Some(index) = self.get_index(key) {
            Some(self.qualifiers.remove(index).1)
        } else {
            None
        }
    }

    /// Unset a typed qualifier.
    pub fn remove_typed<Q>(&mut self)
    where
        Q: KnownQualifierKey,
    {
        self.remove(Q::KEY);
    }

    /// Retain only qualifiers that match the given predicate.
    pub fn retain<F>(&mut self, mut f: F)
    where
        F: FnMut(&QualifierKey, &str) -> bool,
    {
        self.qualifiers.retain(move |q| f(&q.0, &q.1));
    }

    /// Retain only qualifiers that match the given predicate.
    pub fn retain_mut<F>(&mut self, mut f: F)
    where
        F: FnMut(&QualifierKey, &mut SmallString) -> bool,
    {
        self.qualifiers.retain_mut(move |q| f(&q.0, &mut q.1));
    }
}

impl<'a> IntoIterator for &'a Qualifiers {
    type IntoIter = Iter<'a>;
    type Item = (&'a QualifierKey, &'a str);

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl<'a> IntoIterator for &'a mut Qualifiers {
    type IntoIter = IterMut<'a>;
    type Item = (&'a QualifierKey, &'a mut SmallString);

    fn into_iter(self) -> Self::IntoIter {
        self.iter_mut()
    }
}

/// A case-insensitive qualifier name.
///
/// Comparisons between this type and other types are case insensitive.
#[derive(Clone, Debug, Default, Eq, Hash, Ord)]
pub struct QualifierKey(SmallString);

impl<S> PartialEq<S> for QualifierKey
where
    S: AsRef<str> + ?Sized,
{
    fn eq(&self, other: &S) -> bool {
        self.partial_cmp(other).map(|o| o.is_eq()).unwrap_or_default()
    }
}

impl<S> PartialOrd<S> for QualifierKey
where
    S: AsRef<str> + ?Sized,
{
    fn partial_cmp(&self, other: &S) -> Option<Ordering> {
        let other = other.as_ref().chars().flat_map(|c| c.to_lowercase());
        Some(self.0.chars().cmp(other))
    }
}

impl Deref for QualifierKey {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<str> for QualifierKey {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl From<QualifierKey> for SmallString {
    fn from(value: QualifierKey) -> Self {
        SmallString::from(value.0)
    }
}

impl From<&QualifierKey> for SmallString {
    fn from(value: &QualifierKey) -> Self {
        SmallString::from(value.as_str())
    }
}

impl QualifierKey {
    /// Get a reference to the lower case string.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

/// A representation of a qualifier that may or may not exist in the list.
pub enum Entry<'a, K> {
    Occupied(OccupiedEntry<'a, K>),
    Vacant(VacantEntry<'a, K>),
}

impl<'a, K> Entry<'a, K> {
    /// If the qualifier does not exist, create it by inserting `default`.
    ///
    /// Returns a mutable reference to the value of the qualifier.
    pub fn or_insert<V>(self, default: V) -> &'a mut SmallString
    where
        SmallString: From<K> + From<V>,
    {
        match self {
            Entry::Occupied(o) => o.into_mut(),
            Entry::Vacant(v) => v.insert(default),
        }
    }

    /// If the qualifier does not exist, create it by inserting `default()`.
    ///
    /// Returns a mutable reference to the value of the qualifier.
    pub fn or_insert_with<F, V>(self, default: F) -> &'a mut SmallString
    where
        F: FnOnce() -> V,
        SmallString: From<K> + From<V>,
    {
        match self {
            Entry::Occupied(o) => o.into_mut(),
            Entry::Vacant(v) => v.insert(default()),
        }
    }

    /// If the qualifier exists, modify it by calling `f()`.
    pub fn and_modify<F>(mut self, f: F) -> Self
    where
        F: FnOnce(&mut SmallString),
    {
        match &mut self {
            Entry::Occupied(ref mut o) => f(o.get_mut()),
            Entry::Vacant(_) => {},
        }
        self
    }
}

/// A representation of a qualifier that exists in the list.
pub struct OccupiedEntry<'a, K> {
    qualifiers: &'a mut Vec<(QualifierKey, SmallString)>,
    index: usize,
    key: PhantomData<K>,
}

impl<'a, K> OccupiedEntry<'a, K> {
    /// Remove the qualifier from the list and return it as a key-value pair.
    pub fn remove_entry(self) -> (SmallString, SmallString) {
        let (k, v) = self.qualifiers.remove(self.index);
        (k.0, v)
    }

    /// Get the value of the qualifier.
    pub fn get(&self) -> &str {
        &self.qualifiers[self.index].1
    }

    /// Get the value of the qualifier.
    pub fn get_mut(&mut self) -> &mut SmallString {
        &mut self.qualifiers[self.index].1
    }

    /// Convert this entry into a mutable reference to the qualifier's value.
    ///
    /// This is similar to [`Self::get_mut()`] but has different lifetimes.
    pub fn into_mut(self) -> &'a mut SmallString {
        &mut self.qualifiers[self.index].1
    }

    /// Overwrite the value of the qualifier.
    ///
    /// The previous value is returned.
    pub fn insert<V>(&mut self, value: V) -> SmallString
    where
        SmallString: From<V>,
    {
        let mut v = SmallString::from(value);
        mem::swap(&mut v, &mut self.qualifiers[self.index].1);
        v
    }

    /// Remove the qualifier from the list and return its value.
    pub fn remove(self) -> SmallString {
        self.qualifiers.remove(self.index).1
    }
}

/// A representation of a qualifier that does not exist in the list.
pub struct VacantEntry<'a, K> {
    qualifiers: &'a mut Vec<(QualifierKey, SmallString)>,
    index: usize,
    key: MixedQualifierKey<K>,
}

impl<'a, K> VacantEntry<'a, K> {
    /// Insert the qualifier with `value`.
    pub fn insert<V>(self, value: V) -> &'a mut SmallString
    where
        SmallString: From<K> + From<V>,
    {
        self.qualifiers.insert(self.index, (self.key.into_key(), SmallString::from(value)));
        &mut self.qualifiers[self.index].1
    }
}

/// An iterator over the qualifier key value pairs.
#[must_use]
pub struct Iter<'a>(slice::Iter<'a, (QualifierKey, SmallString)>);

impl<'a> Iterator for Iter<'a> {
    type Item = (&'a QualifierKey, &'a str);

    fn next(&mut self) -> Option<Self::Item> {
        let (k, v) = self.0.next()?;
        Some((k, v.as_str()))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.0.len(), Some(self.0.len()))
    }
}

impl ExactSizeIterator for Iter<'_> {}

impl DoubleEndedIterator for Iter<'_> {
    fn next_back(&mut self) -> Option<Self::Item> {
        let (k, v) = self.0.next_back()?;
        Some((k, v.as_str()))
    }
}

fn is_valid_qualifier_name(k: &str) -> bool {
    // https://github.com/package-url/purl-spec/blob/master/PURL-SPECIFICATION.rst#rules-for-each-purl-component
    const ALLOWED_SPECIAL_CHARS: &[char] = &['.', '-', '_'];
    !k.is_empty()
        && k.chars().all(|c| c.is_ascii_alphanumeric() || ALLOWED_SPECIAL_CHARS.contains(&c))
}

/// An iterator over the qualifier key value pairs.
#[must_use]
pub struct IterMut<'a>(slice::IterMut<'a, (QualifierKey, SmallString)>);

impl<'a> Iterator for IterMut<'a> {
    type Item = (&'a QualifierKey, &'a mut SmallString);

    fn next(&mut self) -> Option<Self::Item> {
        let (k, v) = self.0.next()?;
        Some((k, v))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.0.len(), Some(self.0.len()))
    }
}

impl ExactSizeIterator for IterMut<'_> {}

impl DoubleEndedIterator for IterMut<'_> {
    fn next_back(&mut self) -> Option<Self::Item> {
        let (k, v) = self.0.next_back()?;
        Some((k, v))
    }
}

/// A qualifier name wrapper.
///
/// Qualifier names must contain only ascii characters and cannot contain
/// certain characters. They are compared case-insensitively and are canonically
/// lowercase. This wrapper allows us to defer and sometimes avoid copying a key
/// to create a lowercase version of it.
#[must_use]
enum MixedQualifierKey<S> {
    /// A lowercase value that can be used as-is.
    Lower(S),
    /// A mixed-case value.
    Mixed(S),
}

impl<S> MixedQualifierKey<S> {
    /// Convert the `QualifierName` into a `SmallString`.
    ///
    /// If `s` is a `SmallString` or `String` it can be consumed without
    /// copying.
    #[must_use]
    fn into_key(self) -> QualifierKey
    where
        SmallString: From<S>,
    {
        QualifierKey(match self {
            MixedQualifierKey::Lower(s) => SmallString::from(s),
            MixedQualifierKey::Mixed(s) => {
                let mut s = SmallString::from(s);
                s.make_ascii_lowercase();
                s
            },
        })
    }
}

impl<S> AsRef<str> for MixedQualifierKey<S>
where
    S: AsRef<str>,
{
    fn as_ref(&self) -> &str {
        match self {
            MixedQualifierKey::Lower(s) => s.as_ref(),
            MixedQualifierKey::Mixed(s) => s.as_ref(),
        }
    }
}

fn check_qualifier_key<S>(k: S) -> Result<MixedQualifierKey<S>, ParseError>
where
    S: AsRef<str>,
{
    let ks = k.as_ref();
    if !is_valid_qualifier_name(ks) {
        return Err(ParseError::InvalidQualifier);
    }
    if ks.chars().all(|c| c.is_ascii_lowercase()) {
        Ok(MixedQualifierKey::Lower(k))
    } else {
        Ok(MixedQualifierKey::Mixed(k))
    }
}

impl<K> Index<K> for Qualifiers
where
    K: AsRef<str>,
{
    type Output = SmallString;

    fn index(&self, index: K) -> &Self::Output {
        let index = index.as_ref();
        let Some(value) = self.get_index(index).map(|i| &self.qualifiers[i].1) else {
            panic!("Qualifier {index:?} not found");
        };
        value
    }
}

impl<K> IndexMut<K> for Qualifiers
where
    K: AsRef<str>,
{
    fn index_mut(&mut self, index: K) -> &mut Self::Output {
        let index = index.as_ref();
        let Some(value) = self.get_index(index).map(|i| &mut self.qualifiers[i].1) else {
            panic!("Qualifier {index:?} not found");
        };
        value
    }
}

#[cfg(test)]
mod tests {
    use super::well_known::Checksum;
    use super::*;

    fn a_b_c() -> Qualifiers {
        Qualifiers::try_from_iter([("a", "A"), ("b", "B"), ("c", "C")])
            .expect("Could not create test qualifiers")
    }

    #[test]
    fn try_from_iter_with_duplicates_returns_error() {
        let error = Qualifiers::try_from_iter([("a", "A"), ("a", "A")]).unwrap_err();
        assert!(matches!(error, ParseError::InvalidQualifier));
    }

    #[test]
    fn iter_iterates_qualifiers() {
        let qualifiers = a_b_c();
        let mut iter = qualifiers.iter();
        assert_eq!(3, iter.len());
        assert_eq!(Some(("a", "A")), iter.next().map(|(k, v)| (k.as_str(), v)));
        assert_eq!(2, iter.len());
        assert_eq!(Some(("c", "C")), iter.next_back().map(|(k, v)| (k.as_str(), v)));
        assert_eq!(1, iter.len());
        assert_eq!(Some(("b", "B")), iter.next().map(|(k, v)| (k.as_str(), v)));
        assert_eq!(0, iter.len());
    }

    #[test]
    fn iter_mut_iterates_qualifiers() {
        let mut qualifiers = a_b_c();

        let mut iter = qualifiers.iter_mut();
        assert_eq!(3, iter.len());
        assert_eq!(Some(("a", "A")), iter.next().map(|(k, v)| (k.as_str(), v.as_str())));
        assert_eq!(2, iter.len());
        assert_eq!(Some(("c", "C")), iter.next_back().map(|(k, v)| (k.as_str(), v.as_str())));
        assert_eq!(1, iter.len());
        assert_eq!(Some(("b", "B")), iter.next().map(|(k, v)| (k.as_str(), v.as_str())));
        assert_eq!(0, iter.len());
    }

    #[test]
    fn insert_inserts_in_order() {
        let mut qualifiers = Qualifiers::default();
        qualifiers.insert("b", "B").expect("Could not set qualifier b");
        qualifiers.insert("c", "C").expect("Could not set qualifier c");
        qualifiers.insert("a", "A").expect("Could not set qualifier a");

        assert_eq!(
            vec![("a", "A"), ("b", "B"), ("c", "C")],
            qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn insert_converts_to_lower() {
        let mut qualifiers = Qualifiers::default();
        qualifiers.insert("A", "A").expect("Could not set qualifier a");

        assert_eq!(
            vec![("a", "A")],
            qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn insert_with_empty_key_returns_error() {
        let mut qualifiers = Qualifiers::default();
        let error = qualifiers
            .insert("", "A")
            .expect_err("Should not have been able to set qualifier with empty key");

        assert!(matches!(error, ParseError::InvalidQualifier), "Got unexpected error {}", error,);
    }

    #[test]
    fn insert_with_invalid_key_returns_error() {
        let mut qualifiers = Qualifiers::default();
        let error = qualifiers
            .insert("!", "A")
            .expect_err("Should not have been able to set qualifier with invalid key");

        assert!(matches!(error, ParseError::InvalidQualifier), "Got unexpected error {}", error,);
    }

    #[test]
    fn remove_with_empty_key_does_nothing() {
        let mut qualifiers = Qualifiers::default();
        assert_eq!(None, qualifiers.remove(""));
    }

    #[test]
    fn remove_with_invalid_key_does_nothing() {
        let mut qualifiers = Qualifiers::default();
        assert_eq!(None, qualifiers.remove("!"));
    }

    #[test]
    fn remove_with_unset_qualifier_does_nothing() {
        let mut qualifiers = Qualifiers::default();
        assert_eq!(None, qualifiers.remove("a"));
    }

    #[test]
    fn remove_unsets_qualifier() {
        let mut qualifiers = a_b_c();

        assert_eq!(Some("B"), qualifiers.remove("b").as_deref());

        assert_eq!(
            vec![("a", "A"), ("c", "C")],
            qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn remove_with_uppercase_key_unsets_qualifier() {
        let mut qualifiers = a_b_c();

        assert_eq!(Some("B"), qualifiers.remove("B").as_deref());

        assert_eq!(
            vec![("a", "A"), ("c", "C")],
            qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn get_returns_value() {
        let qualifiers = a_b_c();

        assert_eq!(Some("B"), qualifiers.get("b"));
    }

    #[test]
    fn get_with_uppercase_key_returns_value() {
        let qualifiers = a_b_c();

        assert_eq!(Some("B"), qualifiers.get("B"));
    }

    #[test]
    fn get_with_missing_key_returns_none() {
        let qualifiers = a_b_c();

        assert_eq!(None, qualifiers.get("d"));
    }

    #[test]
    fn get_with_invalid_key_returns_none() {
        let qualifiers = a_b_c();

        assert_eq!(None, qualifiers.get("!"));
    }

    #[test]
    fn get_mut_returns_mutable_value() {
        let mut qualifiers = a_b_c();

        let value = qualifiers.get_mut("b").expect("Value should be returned");
        assert_eq!("B", &*value);
        *value = "b".into();
        assert_eq!(Some("b"), qualifiers.get("b"));
    }

    #[test]
    fn get_mut_with_uppercase_key_returns_value() {
        let mut qualifiers = a_b_c();

        assert_eq!(Some("B"), qualifiers.get_mut("B").map(|v| v.as_str()));
    }

    #[test]
    fn get_mut_for_missing_key_returns_none() {
        let mut qualifiers = a_b_c();

        assert_eq!(None, qualifiers.get_mut("d"));
    }

    #[test]
    fn get_mut_for_invalid_key_returns_none() {
        let mut qualifiers = a_b_c();

        assert_eq!(None, qualifiers.get_mut("!"));
    }

    #[test]
    fn contains_key_when_key_exists_returns_true() {
        let qualifiers = a_b_c();
        assert!(qualifiers.contains_key("a"));
    }

    #[test]
    fn contains_key_when_lowercased_key_exists_returns_true() {
        let qualifiers = a_b_c();
        assert!(qualifiers.contains_key("A"));
    }

    #[test]
    fn contains_key_when_key_does_not_exist_returns_false() {
        let qualifiers = a_b_c();
        assert!(!qualifiers.contains_key("aa"));
    }

    #[test]
    fn contains_key_when_key_invalid_returns_false() {
        let qualifiers = a_b_c();
        assert!(!qualifiers.contains_key("!"));
    }

    #[test]
    fn retain_removes_other_qualifiers() {
        let mut qualifiers = a_b_c();
        qualifiers.retain(|k, _v| k == "b");
        assert_eq!(
            vec![("b", "B")],
            qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn retain_is_case_insensitive() {
        let mut qualifiers = a_b_c();
        qualifiers.retain(|k, _v| k == "B");
        assert_eq!(
            vec![("b", "B")],
            qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn retain_mut_can_modify() {
        let mut qualifiers = a_b_c();
        qualifiers.retain_mut(|k, v| {
            v.make_ascii_lowercase();
            k == "b"
        });
        assert_eq!(
            vec![("b", "b")],
            qualifiers.iter().map(|(k, v)| (k.as_str(), v)).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn entry_or_insert_when_exists_returns_existing() {
        let mut qualifiers = a_b_c();
        let value = qualifiers.entry("A").unwrap().or_insert("aa");
        assert_eq!("A", value.as_str());
    }

    #[test]
    fn entry_or_insert_when_does_not_exist_returns_inserted() {
        let mut qualifiers = a_b_c();
        let value = qualifiers.entry("AA").unwrap().or_insert("aa");
        assert_eq!("aa", value.as_str());
        assert_eq!("aa", qualifiers["aa"]);
    }

    #[test]
    fn entry_or_insert_with_when_exists_does_not_call_function() {
        let mut qualifiers = a_b_c();
        let value = qualifiers.entry("A").unwrap().or_insert_with::<_, &str>(|| {
            panic!("Should not be called");
        });
        assert_eq!("A", value.as_str());
    }

    #[test]
    fn entry_or_insert_with_when_does_not_exist_inserts() {
        let mut qualifiers = a_b_c();
        let value = qualifiers.entry("AA").unwrap().or_insert_with(|| "aa");
        assert_eq!("aa", value.as_str());
        assert_eq!("aa", qualifiers["aa"]);
    }

    #[test]
    fn entry_or_modify_when_exists_modifies() {
        let mut qualifiers = a_b_c();
        qualifiers.entry("A").unwrap().and_modify(|v| v.make_ascii_lowercase());
        assert_eq!("a", qualifiers["A"]);
    }

    #[test]
    fn entry_or_modify_when_does_not_exist_does_not_call_function() {
        let mut qualifiers = a_b_c();
        qualifiers.entry("aa").unwrap().and_modify(|_v| {
            panic!("Should not be called");
        });
    }

    #[test]
    fn occupied_entry_remove_removes() {
        let mut qualifiers = a_b_c();
        let Entry::Occupied(entry) = qualifiers.entry("a").unwrap() else {
            panic!("Expected entry to exist before test");
        };
        let value = entry.remove();
        assert_eq!("A", value.as_str());
        assert!(!qualifiers.contains_key("a"));
    }

    #[test]
    fn occupied_entry_insert_overwrites() {
        let mut qualifiers = a_b_c();
        let Entry::Occupied(mut entry) = qualifiers.entry("a").unwrap() else {
            panic!("Expected entry to exist before test");
        };
        let old_value = entry.insert("AA");
        assert_eq!("A", old_value.as_str());
        assert_eq!("AA", entry.get());
        assert_eq!("AA", qualifiers["a"]);
    }

    #[test]
    fn occupied_entry_remove_entry_removes() {
        let mut qualifiers = a_b_c();
        let Entry::Occupied(entry) = qualifiers.entry("a").unwrap() else {
            panic!("Expected entry to exist before test");
        };
        let (key, value) = entry.remove_entry();
        assert_eq!(("a", "A"), (key.as_str(), value.as_str()));
        assert!(!qualifiers.contains_key("a"));
    }

    #[test]
    #[should_panic]
    fn index_does_not_exist_panics() {
        let _value = &Qualifiers::default()["a"];
    }

    #[test]
    #[should_panic]
    fn index_mut_does_not_exist_panics() {
        let _value = &mut Qualifiers::default()["a"];
    }

    #[test]
    fn index_mut_can_set() {
        let mut qualifiers = a_b_c();
        let value = &mut qualifiers["a"];
        *value = "new".into();
        assert_eq!("new", qualifiers["a"].as_str());
    }

    #[test]
    fn len_returns_length() {
        assert_eq!(0, Qualifiers::default().len());
        assert_eq!(1, Qualifiers::try_from_iter([("a", "a")]).unwrap().len());
        assert_eq!(2, Qualifiers::try_from_iter([("a", "a"), ("b", "b")]).unwrap().len(),);
    }

    #[test]
    fn clear_removes_all_entries() {
        let mut qualifiers = a_b_c();
        qualifiers.clear();
        assert_eq!(0, qualifiers.len());
        assert!(qualifiers.iter().next().is_none());
        assert!(qualifiers.get("a").is_none());
    }

    #[test]
    #[should_panic]
    fn insert_typed_when_key_is_invalid_panics() {
        struct Invalid;

        impl KnownQualifierKey for Invalid {
            const KEY: &'static str = "";
        }

        impl From<Invalid> for SmallString {
            fn from(_: Invalid) -> Self {
                SmallString::from("invalid")
            }
        }

        let mut qualifiers = Qualifiers::default();
        qualifiers.insert_typed(Invalid);
    }

    #[test]
    fn try_insert_typed_when_successful_inserts_and_returns_ok() {
        let mut checksums = Checksum::default();
        checksums.insert_raw("hash1", "00".to_owned());
        let mut qualifiers = Qualifiers::default();

        qualifiers.try_insert_typed(checksums).unwrap();

        assert_eq!(1, qualifiers.len());
        assert_eq!(Some("hash1:00"), qualifiers.get(Checksum::KEY));
    }

    #[test]
    fn try_insert_typed_when_unsuccessful_does_insert_and_returns_error() {
        let mut checksums = Checksum::default();
        checksums.insert_raw("hash1", "x".to_owned());
        let mut qualifiers = Qualifiers::try_from_iter([(Checksum::KEY, "hash1:00")]).unwrap();

        let error = qualifiers.try_insert_typed(checksums).unwrap_err();

        assert!(matches!(error, ParseError::InvalidQualifier));
        assert_eq!(1, qualifiers.len());
        assert_eq!(Some("hash1:00"), qualifiers.get(Checksum::KEY));
    }
}
