/* Frozen deterministic small-object allocator workload. Copyright (c) 2026 Hone contributors. MIT licensed. */
#include "bench.h"

#include <mimalloc.h>
#include <stddef.h>
#include <stdint.h>

#define SLOT_COUNT 8192

static bool run_small(uint64_t seed, uint32_t rounds, bool capture_memory, hone_result_t* result) {
  void* slots[SLOT_COUNT] = {0};
  size_t sizes[SLOT_COUNT];
  size_t live[SLOT_COUNT];
  hone_range_t ranges[SLOT_COUNT];
  uint64_t state = seed ^ UINT64_C(0x736d616c6c2d6f62);
  uint64_t checksum = UINT64_C(0x84222325cbf29ce4);
  uint64_t operations = 0;

  for (size_t i = 0; i < SLOT_COUNT; ++i) {
    sizes[i] = 8 + (size_t)(hone_prng_next(&state) % 249);
    checksum = hone_checksum(checksum, sizes[i] + i * UINT64_C(17));
  }

  for (uint32_t round = 0; round < rounds; ++round) {
    for (size_t i = 0; i < SLOT_COUNT; ++i) {
      unsigned char* block = (unsigned char*)mi_malloc(sizes[i]);
      if (block == NULL) goto failure;
      hone_canary_write(block, sizes[i], hone_pattern(seed, round, i));
      slots[i] = block;
      live[i] = sizes[i];
      operations++;
    }
    for (size_t i = round % 3; i < SLOT_COUNT; i += 3) {
      mi_free(slots[i]);
      slots[i] = NULL;
      operations++;
      const size_t replacement_size = 8 + ((sizes[i] * 5 + i + round) % 249);
      unsigned char* replacement = (unsigned char*)mi_zalloc(replacement_size);
      if (replacement == NULL) goto failure;
      /* The zero-fill contract is checked over the WHOLE block before the
       * canary overwrites it. */
      for (size_t j = 0; j < replacement_size; ++j) {
        if (replacement[j] != 0) goto failure;
      }
      hone_canary_write(replacement, replacement_size, hone_pattern(seed, round, SLOT_COUNT + i));
      slots[i] = replacement;
      live[i] = replacement_size;
      operations++;
    }
    /*
     * Every slot is live here. Reject overlapping live ranges, then re-read
     * every block's distinct canary after all later allocations completed —
     * a single recycled buffer cannot satisfy this pass.
     */
    for (size_t i = 0; i < SLOT_COUNT; ++i) {
      ranges[i].begin = (uintptr_t)slots[i];
      ranges[i].end = (uintptr_t)slots[i] + live[i];
    }
    if (!hone_ranges_disjoint(ranges, SLOT_COUNT)) goto failure;
    for (size_t i = 0; i < SLOT_COUNT; ++i) {
      const int replaced = (i % 3) == (round % 3);
      const uint64_t pattern = hone_pattern(seed, round, replaced ? SLOT_COUNT + i : i);
      if (!hone_canary_verify((const unsigned char*)slots[i], live[i], pattern)) goto failure;
      checksum = hone_checksum(checksum, pattern ^ (uint64_t)live[i]);
    }
    if (capture_memory && round == 0 && !hone_capture_memory(result)) goto failure;
    for (size_t i = SLOT_COUNT; i > 0; --i) {
      mi_free(slots[i - 1]);
      slots[i - 1] = NULL;
      operations++;
    }
  }

  result->checksum = checksum;
  result->operations = operations;
  return true;

failure:
  for (size_t i = 0; i < SLOT_COUNT; ++i) mi_free(slots[i]);
  return false;
}

int main(int argc, char** argv) {
  return hone_bench_main("small", argc, argv, run_small);
}
