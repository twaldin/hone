/* Trusted allocator workload harness. Copyright (c) 2026 Hone contributors. MIT licensed. */
#ifndef HONE_MIMALLOC_BENCH_H
#define HONE_MIMALLOC_BENCH_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <mimalloc-stats.h>

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

/*
 * Allocator ABI resolved via dlsym AFTER the control channel authenticates.
 * The harness executable links NO allocator code: the allocator under
 * measurement (candidate or pristine reference) is a shared library that the
 * trusted harness maps only once the trusted parent has proven ownership of
 * both channel ends, so no allocator code can run at process startup or
 * participate in the authentication step.
 */
typedef struct hone_allocator_s {
  void* (*malloc_fn)(size_t size);
  void* (*zalloc_fn)(size_t size);
  void (*free_fn)(void* pointer);
  void (*collect_fn)(bool force);
  void (*stats_reset_fn)(void);
  void (*stats_merge_fn)(void);
  bool (*stats_get_fn)(mi_stats_t* stats);
} hone_allocator_t;

extern hone_allocator_t hone_mi;

typedef bool (*hone_workload_fn)(uint64_t seed, uint32_t rounds, uint64_t nonce, bool capture_memory, hone_result_t* result);

uint64_t hone_prng_next(uint64_t* state);
uint64_t hone_checksum(uint64_t state, uint64_t value);
uint64_t hone_pattern(uint64_t seed, uint64_t round, uint64_t index, uint64_t nonce);
void hone_canary_write(unsigned char* block, size_t size, uint64_t pattern);
bool hone_canary_verify(const unsigned char* block, size_t size, uint64_t pattern);
/* 64-bit word ACTUALLY LOADED from a live block: the value every workload
 * folds into its checksum, so the reported checksum depends on memory read
 * back from real, simultaneously-live allocations rather than on a value the
 * fold recomputes arithmetically. */
uint64_t hone_block_readback(const void* block);
bool hone_ranges_disjoint(hone_range_t* ranges, size_t count);
bool hone_capture_memory(hone_result_t* result);
int hone_bench_main(const char* workload, int argc, char** argv, hone_workload_fn run);

#endif
