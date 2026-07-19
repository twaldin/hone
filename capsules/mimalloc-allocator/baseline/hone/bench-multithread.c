/* Frozen deterministic four-thread allocator workload. Copyright (c) 2026 Hone contributors. MIT licensed. */
#include "bench.h"

#include <mimalloc.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

#define THREAD_COUNT 4
#define THREAD_SLOTS 768

typedef struct thread_work_s {
  uint64_t seed;
  uint32_t rounds;
  bool retain_last;
  bool ok;
  uint64_t checksum;
  uint64_t operations;
  void* slots[THREAD_SLOTS];
} thread_work_t;

static void cleanup_slots(thread_work_t* work) {
  for (size_t i = 0; i < THREAD_SLOTS; ++i) {
    mi_free(work->slots[i]);
    work->slots[i] = NULL;
  }
}

static void* thread_main(void* argument) {
  thread_work_t* work = (thread_work_t*)argument;
  uint64_t checksum = UINT64_C(0x6a09e667f3bcc909);
  work->ok = false;
  for (uint32_t round = 0; round < work->rounds; ++round) {
    uint64_t state = work->seed ^ ((uint64_t)round * UINT64_C(0x9e3779b97f4a7c15));
    for (size_t i = 0; i < THREAD_SLOTS; ++i) {
      const size_t size = 16 + (size_t)(hone_prng_next(&state) % 4081);
      unsigned char* block = (unsigned char*)mi_malloc(size);
      if (block == NULL) {
        cleanup_slots(work);
        return NULL;
      }
      block[0] = (unsigned char)(i + round);
      block[size - 1] = (unsigned char)(work->seed ^ size);
      work->slots[i] = block;
      checksum = hone_checksum(checksum, size + block[0] + ((uint64_t)block[size - 1] << 8));
      work->operations++;
    }
    if (work->retain_last && round + 1 == work->rounds) break;
    for (size_t i = 0; i < THREAD_SLOTS; ++i) {
      mi_free(work->slots[i]);
      work->slots[i] = NULL;
      work->operations++;
    }
  }
  work->checksum = checksum;
  work->ok = true;
  return NULL;
}

static bool run_multithread(uint64_t seed, uint32_t rounds, bool capture_memory, hone_result_t* result) {
  pthread_t threads[THREAD_COUNT];
  thread_work_t work[THREAD_COUNT] = {0};
  size_t started = 0;

  for (size_t thread = 0; thread < THREAD_COUNT; ++thread) {
    work[thread].seed = seed ^ ((thread + 1) * UINT64_C(0xd1b54a32d192ed03));
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
  if (capture_memory && !hone_capture_memory(result)) goto failure;
  if (capture_memory) {
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
