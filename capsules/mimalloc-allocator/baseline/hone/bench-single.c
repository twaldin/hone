/* Frozen deterministic single-thread allocator workload. Copyright (c) 2026 Hone contributors. MIT licensed. */
#include "bench.h"

#include <mimalloc.h>
#include <stddef.h>
#include <stdint.h>

#define SLOT_COUNT 2048

static bool run_single(uint64_t seed, uint32_t rounds, bool capture_memory, hone_result_t* result) {
  void* slots[SLOT_COUNT] = {0};
  size_t sizes[SLOT_COUNT];
  hone_range_t ranges[SLOT_COUNT];
  uint64_t state = seed ^ UINT64_C(0x73696e676c652d31);
  uint64_t checksum = UINT64_C(0xcbf29ce484222325);

  for (size_t i = 0; i < SLOT_COUNT; ++i) {
    const uint64_t random = hone_prng_next(&state);
    sizes[i] = 16 + (size_t)(random % 8177);
    checksum = hone_checksum(checksum, sizes[i] ^ i);
  }

  for (uint32_t round = 0; round < rounds; ++round) {
    for (size_t i = 0; i < SLOT_COUNT; ++i) {
      unsigned char* block = (unsigned char*)mi_malloc(sizes[i]);
      if (block == NULL) goto failure;
      hone_canary_write(block, sizes[i], hone_pattern(seed, round, i));
      slots[i] = block;
    }
    /*
     * Every allocation is still live here. Reject overlapping live ranges,
     * then re-read every block's distinct canary AFTER all later allocations
     * completed: one recycled buffer read back before the next allocation can
     * no longer satisfy the checksum.
     */
    for (size_t i = 0; i < SLOT_COUNT; ++i) {
      ranges[i].begin = (uintptr_t)slots[i];
      ranges[i].end = (uintptr_t)slots[i] + sizes[i];
    }
    if (!hone_ranges_disjoint(ranges, SLOT_COUNT)) goto failure;
    for (size_t i = 0; i < SLOT_COUNT; ++i) {
      const uint64_t pattern = hone_pattern(seed, round, i);
      if (!hone_canary_verify((const unsigned char*)slots[i], sizes[i], pattern)) goto failure;
      checksum = hone_checksum(checksum, pattern ^ (uint64_t)sizes[i]);
    }
    if (capture_memory && round == 0 && !hone_capture_memory(result)) goto failure;
    for (size_t i = 1; i < SLOT_COUNT; i += 2) {
      mi_free(slots[i]);
      slots[i] = NULL;
    }
    for (size_t i = 0; i < SLOT_COUNT; i += 2) {
      mi_free(slots[i]);
      slots[i] = NULL;
    }
  }

  result->checksum = checksum;
  result->operations = (uint64_t)rounds * SLOT_COUNT * 2;
  return true;

failure:
  for (size_t i = 0; i < SLOT_COUNT; ++i) mi_free(slots[i]);
  return false;
}

int main(int argc, char** argv) {
  return hone_bench_main("single", argc, argv, run_single);
}
