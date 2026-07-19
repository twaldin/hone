/* Frozen deterministic fragmentation allocator workload. Copyright (c) 2026 Hone contributors. MIT licensed. */
#include "bench.h"

#include <mimalloc.h>
#include <stddef.h>
#include <stdint.h>

#define SLOT_COUNT 2048

static bool run_fragmentation(uint64_t seed, uint32_t rounds, bool capture_memory, hone_result_t* result) {
  void* slots[SLOT_COUNT] = {0};
  size_t sizes[SLOT_COUNT];
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
      unsigned char* block = (unsigned char*)mi_malloc(sizes[i]);
      if (block == NULL) goto failure;
      block[0] = (unsigned char)(i + round);
      block[sizes[i] - 1] = (unsigned char)(seed >> (i & 7));
      slots[i] = block;
      checksum = hone_checksum(checksum, block[0] | ((uint64_t)block[sizes[i] - 1] << 8));
      operations++;
    }
    for (size_t i = 0; i < SLOT_COUNT; i += 2) {
      mi_free(slots[i]);
      slots[i] = NULL;
      operations++;
    }
    if (capture_memory && round == 0 && !hone_capture_memory(result)) goto failure;
    for (size_t i = 0; i < SLOT_COUNT; i += 2) {
      const size_t replacement_size = 48 + ((sizes[i] ^ (size_t)seed) % 4049);
      unsigned char* replacement = (unsigned char*)mi_malloc(replacement_size);
      if (replacement == NULL) goto failure;
      replacement[0] = (unsigned char)(replacement_size + round);
      slots[i] = replacement;
      checksum = hone_checksum(checksum, replacement[0] + replacement_size);
      operations++;
    }
    for (size_t i = 0; i < SLOT_COUNT; ++i) {
      mi_free(slots[i]);
      slots[i] = NULL;
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
  return hone_bench_main("fragmentation", argc, argv, run_fragmentation);
}
