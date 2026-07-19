//! Precomputed Map builder

#![allow(clippy::uninlined_format_args)]

#[cfg(test)]
mod tests;
mod build;
mod codegen;

use std::{ cmp, fmt };
pub use codegen::*;

/// Static Map builder
///
/// Computes an appropriate static map based on the provided keys.
pub struct MapBuilder<'a, K> {
    seed: Option<u64>,
    limit: Option<u64>,
    ord: Option<OrdFunc<'a, K>>,
    hash: Option<HashFunc<'a, K>>,
    next_seed: fn(u64, u64) -> u64,
    force_build: bool,
}

pub type OrdFunc<'a, K> = &'a dyn Fn(&K, &K) -> cmp::Ordering;
pub type HashFunc<'a, K> = &'a dyn Fn(u64, &K) -> u64;

impl<'a, K> Default for MapBuilder<'a, K> {
    fn default() -> Self {
        MapBuilder::new()
    }
}

impl<'a, K> MapBuilder<'a, K> {
    pub fn new() -> Self {
        MapBuilder {
            limit: None,
            seed: None,
            ord: None,
            hash: None,
            force_build: false,
            next_seed: |init_seed, c| {
                use std::hash::Hasher;

                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                hasher.write_u64(init_seed);
                hasher.write_u64(c);
                hasher.finish()
            },
        }
    }

    /// Try to construct even if keys is very large
    pub fn force_build(&mut self, flag: bool) -> &mut Self {
        self.force_build = flag;
        self
    }

    pub fn set_limit(&mut self, limit: Option<u64>) -> &mut Self {
        self.limit = limit;
        self
    }

    pub fn set_seed(&mut self, seed: u64) -> &mut Self {
        self.seed = Some(seed);
        self
    }

    pub fn set_ord(&mut self, f: OrdFunc<'a, K>) -> &mut Self {
        self.ord = Some(f);
        self
    }

    pub fn set_hash(&mut self, f: HashFunc<'a, K>) -> &mut Self {
        self.hash = Some(f);
        self
    }

    pub fn set_next_seed(&mut self, f: fn(u64, u64) -> u64)
        -> &mut Self
    {
        self.next_seed = f;
        self
    }

    /// Creates a Map with the specified keys
    ///
    /// # NOTE
    ///
    /// Note that the keys used must be unique, otherwise the build will not succeed.
    pub fn build(&self, keys: &[K]) -> Result<MapOutput, BuildFailed> {
        if keys.len() <= 16 {
            // For tiny amounts of data, binary search is usually faster.
            //
            // At most 4 comparisons will be faster than a high-quality hash.
            if let Some(output) = build::build_tiny(self, keys) {
                return Ok(output);
            }
        }

        if keys.len() <= 128 {
            // For small numbers of keys, try to build the smallest and fastest phf.
            //
            // This outperforms all other phfs,
            // but for large numbers of keys, this may not be able to find the seed in a reasonable time.
            //
            // If the keys length is greater than 12, it will usually fallback to medium map.
            if let Some(output) = build::build_small(self, keys) {
                return Ok(output);
            }
        }

        if !self.force_build && keys.len() > 10 * 1024 * 1024 {
            return Err(BuildFailed("WARN: \
                We currently don't have good support for large numbers of keys,\
                and this construction may be slow or not complete in a reasonable time.\
            "));
        }

        // A typical PHF, but not optimized for construction time, and no sharding.
        // 
        // It is suitable for large amounts of data that need to be embedded in a binary file,
        // but for data larger than that it is better to use a specialized PHF library.
        build::build_medium(self, keys)
    }
}

#[derive(Debug)]
pub struct BuildFailed(&'static str);

#[derive(Debug)]
enum MapKind {
    Tiny,
    Small(u64),
    Medium {
        seed: u64,
        pilots: Box<[u8]>,
        remap: Box<[u32]>,
    }
}

impl fmt::Display for BuildFailed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for BuildFailed {}

/// Map output
#[derive(Debug)]
pub struct MapOutput {
    kind: MapKind,
    index: Box<[usize]>
}
