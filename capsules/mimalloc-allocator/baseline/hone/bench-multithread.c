/* Frozen deterministic four-thread allocator workload. Copyright (c) 2026 Hone contributors. MIT licensed. */
#include "bench.h"

#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

#define THREAD_COUNT 4
#define THREAD_SLOTS 768

typedef struct thread_work_s {
  uint64_t seed;
  uint64_t nonce;
  uint32_t rounds;
  bool retain_last;
  bool ok;
  uint64_t checksum;
  uint64_t operations;
  void* slots[THREAD_SLOTS];
  size_t live[THREAD_SLOTS];
} thread_work_t;

static void cleanup_slots(thread_work_t* work) {
  for (size_t i = 0; i < THREAD_SLOTS; ++i) {
    hone_mi.free_fn(work->slots[i]);
    work->slots[i] = NULL;
  }
}

static void* thread_main(void* argument) {
  thread_work_t* work = (thread_work_t*)argument;
  hone_range_t ranges[THREAD_SLOTS];
  uint64_t checksum = UINT64_C(0x6a09e667f3bcc909);
  work->ok = false;
  for (uint32_t round = 0; round < work->rounds; ++round) {
    uint64_t state = work->seed ^ ((uint64_t)round * UINT64_C(0x9e3779b97f4a7c15));
    for (size_t i = 0; i < THREAD_SLOTS; ++i) {
      const size_t size = 16 + (size_t)(hone_prng_next(&state) % 4081);
      unsigned char* block = (unsigned char*)hone_mi.malloc_fn(size);
      if (block == NULL) {
        cleanup_slots(work);
        return NULL;
      }
      hone_canary_write(block, size, hone_pattern(work->seed, round, i, work->nonce));
      work->slots[i] = block;
      work->live[i] = size;
      work->operations++;
    }
    /*
     * All of this thread's allocations are live: reject overlapping live
     * ranges and re-read every block's distinct canary after all later
     * allocations completed. The checksum folds the 64-bit word LOADED from
     * each live block, so it depends on memory actually written and read
     * back inside the timed window. Cross-thread overlap is verified once
     * over the retained final round in run_multithread.
     */
    for (size_t i = 0; i < THREAD_SLOTS; ++i) {
      ranges[i].begin = (uintptr_t)work->slots[i];
      ranges[i].end = (uintptr_t)work->slots[i] + work->live[i];
    }
    if (!hone_ranges_disjoint(ranges, THREAD_SLOTS)) {
      cleanup_slots(work);
      return NULL;
    }
    for (size_t i = 0; i < THREAD_SLOTS; ++i) {
      const uint64_t pattern = hone_pattern(work->seed, round, i, work->nonce);
      if (!hone_canary_verify((const unsigned char*)work->slots[i], work->live[i], pattern)) {
        cleanup_slots(work);
        return NULL;
      }
      checksum = hone_checksum(checksum, hone_block_readback(work->slots[i]) ^ (uint64_t)work->live[i]);
    }
    if (work->retain_last && round + 1 == work->rounds) break;
    for (size_t i = 0; i < THREAD_SLOTS; ++i) {
      hone_mi.free_fn(work->slots[i]);
      work->slots[i] = NULL;
      work->operations++;
    }
  }
  work->checksum = checksum;
  work->ok = true;
  return NULL;
}

static bool run_multithread(uint64_t seed, uint32_t rounds, uint64_t nonce, bool capture_memory, hone_result_t* result) {
  pthread_t threads[THREAD_COUNT];
  thread_work_t work[THREAD_COUNT] = {0};
  hone_range_t all_ranges[THREAD_COUNT * THREAD_SLOTS];
  size_t started = 0;

  for (size_t thread = 0; thread < THREAD_COUNT; ++thread) {
    work[thread].seed = seed ^ ((thread + 1) * UINT64_C(0xd1b54a32d192ed03));
    work[thread].nonce = nonce;
    work[thread].rounds = rounds;
    work[thread].retain_last = capture_memory;
    if (pthread_create(&threads[thread], NULL, thread_main, &work[thread]) != 0) goto failure;
    started++;
  }
  for (size_t thread = 0; thread < started; ++thread) {
    if (pthread_join(threads[thread], NULL) != 0) return false;
  }
  started = 0;
  for (size_t thread = 0; thread < THREAD_COUNT; ++thread) {
    if (!work[thread].ok) goto failure;
    result->checksum = hone_checksum(result->checksum, work[thread].checksum ^ thread);
    result->operations += work[thread].operations;
  }
  if (capture_memory) {
    /*
     * The final round of every thread is retained, so all THREAD_COUNT live
     * sets coexist here: reject cross-thread overlap and re-verify the
     * per-thread canaries one last time before release.
     */
    for (size_t thread = 0; thread < THREAD_COUNT; ++thread) {
      for (size_t i = 0; i < THREAD_SLOTS; ++i) {
        const size_t slot = thread * THREAD_SLOTS + i;
        all_ranges[slot].begin = (uintptr_t)work[thread].slots[i];
        all_ranges[slot].end = (uintptr_t)work[thread].slots[i] + work[thread].live[i];
      }
    }
    if (!hone_ranges_disjoint(all_ranges, THREAD_COUNT * THREAD_SLOTS)) goto failure;
    for (size_t thread = 0; thread < THREAD_COUNT; ++thread) {
      for (size_t i = 0; i < THREAD_SLOTS; ++i) {
        const uint64_t pattern = hone_pattern(work[thread].seed, rounds - 1, i, nonce);
        if (!hone_canary_verify((const unsigned char*)work[thread].slots[i], work[thread].live[i], pattern)) {
          goto failure;
        }
      }
    }
    if (!hone_capture_memory(result)) goto failure;
    for (size_t thread = 0; thread < THREAD_COUNT; ++thread) {
      cleanup_slots(&work[thread]);
      result->operations += THREAD_SLOTS;
    }
  }
  return true;

failure:
  for (size_t thread = 0; thread < started; ++thread) pthread_join(threads[thread], NULL);
  for (size_t thread = 0; thread < THREAD_COUNT; ++thread) cleanup_slots(&work[thread]);
  return false;
}

int main(int argc, char** argv) {
  return hone_bench_main("multithread", argc, argv, run_multithread);
}
