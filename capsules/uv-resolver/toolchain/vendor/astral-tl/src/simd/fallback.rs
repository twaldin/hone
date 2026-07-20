use crate::util;

/// Fallback for searching for the first non-identifier
#[inline(never)]
#[cold]
pub fn search_non_ident(haystack: &[u8]) -> Option<usize> {
    haystack.iter().position(|&c| !util::is_ident(c))
}
