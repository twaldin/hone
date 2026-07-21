/* Trusted allocator benchmark runtime. Copyright (c) 2026 Hone contributors. MIT licensed. */
#define _GNU_SOURCE
#include "bench.h"

#include <errno.h>
#include <inttypes.h>
#include <math.h>
#include <mimalloc-stats.h>
#include <mimalloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define HONE_SAMPLES 5
#define HONE_MAX_ROUNDS (UINT32_C(1) << 20)

static volatile uint64_t hone_sink;

/*
 * Timing crosses a non-interposable direct-syscall boundary. The benchmark
 * links the mutable allocator archive into this same executable, so a plain
 * clock_gettime reference could be resolved by the static linker to a
 * candidate-provided strong symbol. Emitting the syscall instruction inline
 * removes that seam entirely; the trusted evaluator additionally rejects any
 * candidate-defined timing or output symbols before this binary is run.
 */
static uint64_t monotonic_ns(void) {
  struct timespec ts;
  ts.tv_sec = 0;
  ts.tv_nsec = 0;
  long rc;
#if defined(__aarch64__)
  register long x8 __asm__("x8") = 113; /* __NR_clock_gettime */
  register long x0 __asm__("x0") = (long)CLOCK_MONOTONIC_RAW;
  register long x1 __asm__("x1") = (long)&ts;
  __asm__ volatile("svc #0" : "+r"(x0) : "r"(x8), "r"(x1) : "memory");
  rc = x0;
#elif defined(__x86_64__)
  register long rdi __asm__("rdi") = (long)CLOCK_MONOTONIC_RAW;
  register long rsi __asm__("rsi") = (long)&ts;
  __asm__ volatile("syscall"
                   : "=a"(rc)
                   : "a"(228L), "r"(rdi), "r"(rsi) /* __NR_clock_gettime */
                   : "rcx", "r11", "memory");
#else
  rc = clock_gettime(CLOCK_MONOTONIC_RAW, &ts);
#endif
  if (rc != 0) return 0;
  return (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
}

uint64_t hone_prng_next(uint64_t* state) {
  uint64_t x = *state;
  x ^= x >> 12;
  x ^= x << 25;
  x ^= x >> 27;
  *state = x;
  return x * UINT64_C(2685821657736338717);
}

uint64_t hone_checksum(uint64_t state, uint64_t value) {
  state ^= value + UINT64_C(0x9e3779b97f4a7c15) + (state << 6) + (state >> 2);
  return state;
}

bool hone_capture_memory(hone_result_t* result) {
  mi_stats_t_decl(stats);
  mi_stats_merge();
  if (!mi_stats_get(&stats) || stats.page_committed.current <= 0 ||
      stats.page_committed.peak <= 0 || stats.malloc_normal.current < 0 ||
      stats.malloc_huge.current < 0) {
    return false;
  }
  const uint64_t committed = (uint64_t)stats.page_committed.current;
  const uint64_t allocated =
    (uint64_t)stats.malloc_normal.current + (uint64_t)stats.malloc_huge.current;
  result->peak_committed = (size_t)stats.page_committed.peak;
  result->fragmentation = (committed > allocated)
    ? (double)(committed - allocated) / (double)committed
    : 0.0;
  result->memory_captured = true;
  return true;
}

static int compare_double(const void* left, const void* right) {
  const double a = *(const double*)left;
  const double b = *(const double*)right;
  return (a > b) - (a < b);
}

static bool parse_u64(const char* text, uint64_t* value) {
  char* end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(text, &end, 10);
  if (errno != 0 || text[0] == '\0' || end == NULL || *end != '\0') return false;
  *value = (uint64_t)parsed;
  return true;
}

int hone_bench_main(const char* workload, int argc, char** argv, hone_workload_fn run) {
  uint64_t seed;
  uint64_t target_ms;
  if (argc != 3 || !parse_u64(argv[1], &seed) || seed == 0 ||
      !parse_u64(argv[2], &target_ms) || target_ms < 50 || target_ms > 2000) {
    return 64;
  }

  hone_result_t probe = {0};
  if (!run(seed, 1, false, &probe) || probe.operations == 0) return 1;

  const uint64_t target_ns = target_ms * UINT64_C(1000000);
  uint32_t rounds = 1;
  for (;;) {
    hone_result_t calibration = {0};
    const uint64_t started = monotonic_ns();
    if (started == 0 || !run(seed, rounds, false, &calibration)) return 1;
    const uint64_t elapsed = monotonic_ns() - started;
    if (elapsed >= target_ns || rounds >= HONE_MAX_ROUNDS) break;
    uint64_t next;
    if (elapsed == 0) {
      next = (uint64_t)rounds * 8;
    } else {
      const double scale = (double)target_ns / (double)elapsed;
      next = (uint64_t)((double)rounds * (scale > 8.0 ? 8.0 : scale * 1.10));
    }
    if (next <= rounds) next = (uint64_t)rounds + 1;
    rounds = (uint32_t)(next > HONE_MAX_ROUNDS ? HONE_MAX_ROUNDS : next);
  }

  double samples[HONE_SAMPLES];
  for (size_t sample = 0; sample < HONE_SAMPLES; ++sample) {
    hone_result_t measured = {0};
    const uint64_t started = monotonic_ns();
    if (started == 0 || !run(seed, rounds, false, &measured)) return 1;
    const uint64_t elapsed = monotonic_ns() - started;
    if (elapsed == 0 || measured.operations == 0) return 1;
    samples[sample] = (double)measured.operations * 1000000000.0 / (double)elapsed;
    hone_sink ^= measured.checksum;
  }
  /*
   * Robustness: report the fastest sample (k=1 of N trimmed selection).
   * Host or sibling-container contention can only lengthen a sample, never
   * shorten it, so the minimum rejects scheduler-noise outliers without
   * giving candidate code any influence over the selection.
   */
  qsort(samples, HONE_SAMPLES, sizeof(samples[0]), compare_double);

  mi_collect(true);
  mi_stats_reset();
  hone_result_t validation = {0};
  if (!run(seed, 1, true, &validation) || !validation.memory_captured ||
      validation.peak_committed == 0 || !isfinite(validation.fragmentation) ||
      validation.fragmentation < 0.0 || validation.fragmentation > 1.0) {
    return 1;
  }
  hone_sink ^= validation.checksum;
  printf("ok %s %.9f %016" PRIx64 " %zu %.12f %u %" PRIu64 "\n",
         workload, samples[HONE_SAMPLES - 1], validation.checksum,
         validation.peak_committed, validation.fragmentation, rounds, hone_sink);
  return 0;
}
