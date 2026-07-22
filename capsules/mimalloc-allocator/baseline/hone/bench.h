/* Trusted allocator workload harness. Copyright (c) 2026 Hone contributors. MIT licensed. */
#ifndef HONE_MIMALLOC_BENCH_H
#define HONE_MIMALLOC_BENCH_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct hone_result_s {
  uint64_t checksum;
  uint64_t operations;
  size_t peak_committed;
  double fragmentation;
  bool memory_captured;
} hone_result_t;

/* Half-open live allocation range [begin, end); sorted in place by the
 * disjointness check. */
typedef struct hone_range_s {
  uintptr_t begin;
  uintptr_t end;
} hone_range_t;

typedef bool (*hone_workload_fn)(uint64_t seed, uint32_t rounds, bool capture_memory, hone_result_t* result);

uint64_t hone_prng_next(uint64_t* state);
uint64_t hone_checksum(uint64_t state, uint64_t value);
uint64_t hone_pattern(uint64_t seed, uint64_t round, uint64_t index);
void hone_canary_write(unsigned char* block, size_t size, uint64_t pattern);
bool hone_canary_verify(const unsigned char* block, size_t size, uint64_t pattern);
bool hone_ranges_disjoint(hone_range_t* ranges, size_t count);
bool hone_capture_memory(hone_result_t* result);
int hone_bench_main(const char* workload, int argc, char** argv, hone_workload_fn run);

#endif
