use std::cmp;
use crate::{ phf, fast_reduct32, low, high };
use super::*;

pub(super) fn build_tiny<K>(builder: &MapBuilder<'_, K>, keys: &[K])
    -> Option<MapOutput>
{
    let ord = builder.ord.as_ref()?;

    let mut index = (0..keys.len()).collect::<Box<[_]>>();
    index.sort_by(|&x, &y| ord(&keys[x], &keys[y]));

    Some(MapOutput {
        kind: MapKind::Tiny,
        index
    }) 
}

pub(super) fn build_small<K>(builder: &MapBuilder<'_, K>, keys: &[K])
    -> Option<MapOutput>
{
    let hash = builder.hash.as_ref()?;
    let next_seed = builder.next_seed;
    
    let init_seed = builder.seed.unwrap_or_else(|| {
        use std::hash::BuildHasher;
    
        std::collections::hash_map::RandomState::new().hash_one(0x42)
    });
    let mut seed = init_seed;

    let mut hashes = Vec::with_capacity(keys.len());
    let mut map = vec![None; keys.len()];
    let keys_len: u32 = keys.len().try_into().unwrap();

    'search: for c in 0..(128 * 1024) {
        map.iter_mut().for_each(|idx| *idx = None);
        hashes.clear();
        hashes.extend(keys.iter().map(|v| hash(seed, v)));

        for (idx, &v) in hashes.iter().enumerate() {
            let new_idx = fast_reduct32(high(v) ^ low(v), keys_len) as usize;

            if map[new_idx].replace(idx).is_some() {
                seed = next_seed(init_seed, c);
                continue 'search;
            }
        }

        break
    }

    let map = map.into_iter().collect::<Option<Box<[usize]>>>()?;

    Some(MapOutput {
        kind: MapKind::Small(seed),
        index: map
    })
}

pub(super) fn build_medium<K>(builder: &MapBuilder<'_, K>, keys: &[K])
    -> Result<MapOutput, BuildFailed>
{
    // We basically have a no-shard [ptrhash](https://curiouscoding.nl/posts/ptrhash-log/),
    // but there are slight differences in the construction algorithms.
    //
    // By avoid all unsafe and complex third-party dependencies,
    // we are currently much slower than the official implementation.
    // but it's basically fast enough for the scale of embedded binaries that are suitable.
    
    #[derive(Default)]
    struct Bucket {
        slots: Vec<usize>
    }

    struct Slot {
        bucket: u32,
        keys_idx: usize,
    }

    fn reduct(hashes: &[u64], idx: usize, hp: u64, slots_len: u32) -> u32 {
        fast_reduct32(high(hashes[idx]) ^ high(hp) ^ low(hp), slots_len)
    }
    
    let hash = builder.hash.as_ref().ok_or(BuildFailed("need hash method"))?;
    let next_seed = builder.next_seed;
    
    let init_seed = builder.seed.unwrap_or_else(|| {
        use std::hash::BuildHasher;
    
        std::collections::hash_map::RandomState::new().hash_one(0x42)
    });
    let mut seed = init_seed;

    let alpha = 0.99;
    let lambda = 3.0;

    let keys_len: u32 = keys.len().try_into().unwrap();
    let slots_len = {
        let len = (f64::from(keys_len) / alpha).ceil() as u32;

        // Avoid powers of two, since then %S does not depend on all bits.
        len + (len.is_power_of_two() as u32)
    };
    let buckets_len = {
        let len = (f64::from(keys_len) / lambda).ceil() as u32;

        // Add a few extra buckets to avoid collisions for small n.
        len + 3
    };

    let mut buckets = (0..buckets_len)
        .map(|_| Bucket::default())
        .collect::<Box<[_]>>();
    let mut pilots = vec![0; buckets_len as usize].into_boxed_slice();
    let mut order = (0..buckets_len).collect::<Box<_>>();
    let mut slots = (0..slots_len).map(|_| None).collect::<Box<[_]>>();
    let mut hashes = vec![0; keys.len()].into_boxed_slice();
    let mut stack = Vec::new();

    // since the number is small enough, we just use naive search
    let mut values_to_add = Vec::with_capacity(lambda as usize * 2);
    let mut recent = Vec::new();
    let mut already_scored = Vec::new();

    'search: for c in 0.. {
        buckets.iter_mut().for_each(|bucket| bucket.slots.clear());
        pilots.iter_mut().for_each(|p| *p = 0);
        slots.iter_mut().for_each(|slot| *slot = None);

        if builder.limit
            .filter(|&limit| c > limit)
            .is_some()
        {
            break
        }

        hashes.iter_mut()
            .enumerate()
            .for_each(|(idx, v)| {
                *v = hash(seed, &keys[idx]);
            });

        for (idx, &v) in hashes.iter().enumerate() {
            let bucket_idx = fast_reduct32(low(v), buckets_len) as usize;
            buckets[bucket_idx].slots.push(idx);
        }

        order.sort_unstable_by_key(|&bucket_idx| cmp::Reverse(buckets[bucket_idx as usize].slots.len()));

        for &bucket_idx in &order {
            if buckets[bucket_idx as usize].slots.is_empty() {
                debug_assert_eq!(pilots[bucket_idx as usize], 0);
                continue
            }
            
            recent.clear();
            stack.clear();
            stack.push(bucket_idx);

            'bucket: while let Some(bucket_idx) = {
                // big bucket first
                stack.sort_unstable_by_key(|&bucket_idx| buckets[bucket_idx as usize].slots.len());
                stack.pop()
            } {
                // Do not evict buckets that have already been evicted.
                //
                // this is simpler than the original ptr-hash code, but can completely prevent cycles.
                recent.push(bucket_idx);

                // fast search pilot
                'pilot: for p in 0..=u8::MAX {
                    values_to_add.clear();

                    let hp = phf::hash_pilot(seed, p);

                    for (keys_idx, slot_idx) in buckets[bucket_idx as usize]
                        .slots
                        .iter()
                        .map(|&keys_idx| (keys_idx, reduct(&hashes, keys_idx, hp, slots_len)))
                    {
                        if slots[slot_idx as usize].is_some()
                            || values_to_add.iter().any(|(prev_slot_idx, _)| *prev_slot_idx == slot_idx)
                        {
                            continue 'pilot
                        }

                        values_to_add.push((slot_idx, keys_idx));
                    }

                    pilots[bucket_idx as usize] = p;

                    for &(slot_idx, keys_idx) in &values_to_add {
                        slots[slot_idx as usize] = Some(Slot {
                            bucket: bucket_idx,
                            keys_idx 
                        });
                    }

                    continue 'bucket
                }

                // search best pilot (minimal collisions)
                let mut best = None;

                'pilot: for p in 0..=u8::MAX {
                    values_to_add.clear();
                    already_scored.clear();

                    // start from a slightly different point, just 42 because we don't like random.
                    let p = p.wrapping_add(0x42);
                    let hp = phf::hash_pilot(seed, p);
                    let mut collision_score = 0;

                    for (keys_idx, slot_idx) in buckets[bucket_idx as usize].slots
                        .iter()
                        .map(|&keys_idx| (keys_idx, reduct(&hashes, keys_idx, hp, slots_len)))
                    {
                        if values_to_add.iter().any(|(prev_slot_idx, _)| *prev_slot_idx == slot_idx) {
                            continue 'pilot
                        }
                        
                        let new_score = match slots[slot_idx as usize].as_ref() {
                            None => 0,
                            Some(slot) if recent.contains(&slot.bucket) =>
                                continue 'pilot,
                            Some(slot) if !already_scored.contains(&slot.bucket) => {
                                already_scored.push(slot.bucket);
                                buckets[slot.bucket as usize].slots.len().pow(2)
                            },
                            Some(_) => 0
                        };

                        values_to_add.push((slot_idx, keys_idx));
                        collision_score += new_score;

                        if best
                            .filter(|(best_score, _)| collision_score >= *best_score)
                            .is_some()
                        {
                            continue 'pilot
                        }
                    }

                    best = Some((collision_score, p));

                    // Since we already checked for a collision-free solution,
                    // the next best is a single collision of size b_len.
                    if collision_score == buckets[bucket_idx as usize].slots.len().pow(2) {
                        break
                    }
                }

                let Some((_, p)) = best else {
                    // No available pilot was found, so this seed is abandoned.
                    seed = next_seed(init_seed, c);
                    continue 'search
                };

                pilots[bucket_idx as usize] = p;
                let hp = phf::hash_pilot(seed, p);

                for (keys_idx, slot_idx) in buckets[bucket_idx as usize].slots
                    .iter()
                    .map(|&keys_idx| (keys_idx, reduct(&hashes, keys_idx, hp, slots_len)))
                {
                    if let Some(old_slot) = slots[slot_idx as usize]
                        .replace(Slot {
                            bucket: bucket_idx,
                            keys_idx
                        })
                    {
                        debug_assert!(!stack.contains(&old_slot.bucket), "{:?}", (&stack, old_slot.bucket));
                        
                        // Eviction conflict bucket
                        stack.push(old_slot.bucket);

                        let hp = phf::hash_pilot(seed, pilots[old_slot.bucket as usize]);
                        for old_slot_idx in buckets[old_slot.bucket as usize].slots
                            .iter()
                            .map(|&keys_idx| reduct(&hashes, keys_idx, hp, slots_len))
                            .filter(|&old_slot_idx| old_slot_idx != slot_idx)
                        {
                            debug_assert_eq!(slots[old_slot_idx as usize].as_ref().unwrap().bucket, old_slot.bucket, "{:?}", (bucket_idx, old_slot_idx));
                            slots[old_slot_idx as usize] = None;
                        }
                    }
                }
            }
        }

        let mut index = vec![0; keys.len()].into_boxed_slice();
        let mut remap = vec![0; slots.len() - index.len()].into_boxed_slice();
        let mut remap_slots = Vec::new();

        for (slot_idx, slot) in slots.iter().enumerate() {
            match (slot_idx.checked_sub(index.len()), slot) {
                (None, Some(slot)) => index[slot_idx] = slot.keys_idx,
                (None, None) => remap_slots.push(slot_idx),
                (Some(offset), Some(slot)) => {
                    let remap_slot = remap_slots.pop().unwrap();
                    remap[offset] = remap_slot.try_into().unwrap();
                    index[remap_slot] = slot.keys_idx
                },
                (Some(_), None) => ()
            }
        }

        return Ok(MapOutput {
            kind: MapKind::Medium {
                seed, pilots, remap
            },
            index
        });
    }

    Err(BuildFailed("build failed"))
}
