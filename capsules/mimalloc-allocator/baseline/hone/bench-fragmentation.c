/* Frozen deterministic fragmentation allocator workload. Copyright (c) 2026 Hone contributors. MIT licensed. */
#include "bench.h"

#include <stddef.h>
#include <stdint.h>

#define SLOT_COUNT 2048

/* Overlap + canary pass over the CURRENT live set; folds the 64-bit word
 * LOADED from every live block into the checksum so verification is part of
 * the scored value (not a side gate) and the checksum depends on memory
 * actually written and read back inside the timed window. */
static bool verify_live(void* const* slots, const size_t* live, const uint64_t* patterns,
                        hone_range_t* ranges, uint64_t* checksum) {
  for (size_t i = 0; i < SLOT_COUNT; ++i) {
    ranges[i].begin = (uintptr_t)slots[i];
    ranges[i].end = (uintptr_t)slots[i] + live[i];
  }
  if (!hone_ranges_disjoint(ranges, SLOT_COUNT)) return false;
  for (size_t i = 0; i < SLOT_COUNT; ++i) {
    if (!hone_canary_verify((const unsigned char*)slots[i], live[i], patterns[i])) return false;
    *checksum = hone_checksum(*checksum, hone_block_readback(slots[i]) ^ (uint64_t)live[i]);
  }
  return true;
}

static bool run_fragmentation(uint64_t seed, uint32_t rounds, uint64_t nonce, bool capture_memory, hone_result_t* result) {
  void* slots[SLOT_COUNT] = {0};
  size_t sizes[SLOT_COUNT];
  size_t live[SLOT_COUNT];
  uint64_t patterns[SLOT_COUNT];
  hone_range_t ranges[SLOT_COUNT];
  uint64_t state = seed ^ UINT64_C(0x667261676d656e74);
  uint64_t checksum = UINT64_C(0x9e3779b97f4a7c15);
  uint64_t operations = 0;

  for (size_t i = 0; i < SLOT_COUNT; ++i) {
    const uint64_t random = hone_prng_next(&state);
    sizes[i] = 64 + (size_t)(random % 65473);
    checksum = hone_checksum(checksum, sizes[i] ^ (i * UINT64_C(131)));
  }

  for (uint32_t round = 0; round < rounds; ++round) {
    for (size_t i = 0; i < SLOT_COUNT; ++i) {
      unsigned char* block = (unsigned char*)hone_mi.malloc_fn(sizes[i]);
      if (block == NULL) goto failure;
      patterns[i] = hone_pattern(seed, round, i, nonce);
      hone_canary_write(block, sizes[i], patterns[i]);
      slots[i] = block;
      live[i] = sizes[i];
      operations++;
    }
    /* First stable point: all SLOT_COUNT initial allocations live at once. */
    if (!verify_live(slots, live, patterns, ranges, &checksum)) goto failure;
    for (size_t i = 0; i < SLOT_COUNT; i += 2) {
      hone_mi.free_fn(slots[i]);
      slots[i] = NULL;
      operations++;
    }
    if (capture_memory && round == 0 && !hone_capture_memory(result)) goto failure;
    for (size_t i = 0; i < SLOT_COUNT; i += 2) {
      const size_t replacement_size = 48 + ((sizes[i] ^ (size_t)seed) % 4049);
      unsigned char* replacement = (unsigned char*)hone_mi.malloc_fn(replacement_size);
      if (replacement == NULL) goto failure;
      patterns[i] = hone_pattern(seed, round, SLOT_COUNT + i, nonce);
      hone_canary_write(replacement, replacement_size, patterns[i]);
      slots[i] = replacement;
      live[i] = replacement_size;
      operations++;
    }
    /* Second stable point: surviving odd blocks + even replacements live. */
    if (!verify_live(slots, live, patterns, ranges, &checksum)) goto failure;
    for (size_t i = 0; i < SLOT_COUNT; ++i) {
      hone_mi.free_fn(slots[i]);
      slots[i] = NULL;
      operations++;
    }
  }

  result->checksum = checksum;
  result->operations = operations;
  return true;

failure:
  for (size_t i = 0; i < SLOT_COUNT; ++i) hone_mi.free_fn(slots[i]);
  return false;
}

int main(int argc, char** argv) {
  return hone_bench_main("fragmentation", argc, argv, run_fragmentation);
}
