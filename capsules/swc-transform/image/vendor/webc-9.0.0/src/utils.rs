#![allow(dead_code)]

use std::path::Path;

use sha2::{Digest, Sha256};

pub(crate) fn length_field(value: impl AsRef<[u8]>) -> [u8; 8] {
    let length: u64 = value.as_ref().len().try_into().unwrap();
    length.to_le_bytes()
}

pub(crate) fn sha256(data: impl AsRef<[u8]>) -> [u8; 32] {
    let mut state = Sha256::default();
    state.update(data.as_ref());
    state.finalize().into()
}

/// Find the offset of a `needle` within a large `haystack` allocation.
///
/// # Panics
///
/// This will panic if the needle lies outside of the allocation.
#[track_caller]
pub(crate) fn subslice_offsets(haystack: &[u8], needle: &[u8]) -> std::ops::Range<usize> {
    let haystack_range = haystack.as_ptr_range();
    let needle_range = needle.as_ptr_range();

    assert!(
        haystack_range.start <= needle_range.start && needle_range.end <= haystack_range.end,
        "expected {needle_range:?} to lie within {haystack_range:?}",
    );

    let start = (needle_range.start as usize)
        .checked_sub(haystack_range.start as usize)
        .expect("Needle out of range");
    let end = (needle_range.end as usize)
        .checked_sub(haystack_range.start as usize)
        .expect("Needle out of range");

    start..end
}

/// Turn any path that gets passed in into something WASI can use.
///
/// In general, this means...
///
/// - Use "/" everywhere
/// - Remove "." or ".." components
/// - Make the path absolute because when loaded it'll be absolute with respect
///   to the volume
/// - Get rid of any UNC path stuff
pub fn sanitize_path(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();

    let mut segments = Vec::new();

    for component in path.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {}
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                segments.pop();
            }
            std::path::Component::Normal(segment) => {
                segments.push(segment.to_string_lossy());
            }
        }
    }

    let mut sanitized = String::new();

    for segment in segments {
        sanitized.push('/');
        sanitized.push_str(&segment);
    }

    if sanitized.is_empty() {
        sanitized.push('/');
    }

    sanitized
}
