/* Trusted allocator benchmark runtime. Copyright (c) 2026 Hone contributors. MIT licensed. */
#define _GNU_SOURCE
#include "bench.h"

#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define HONE_SAMPLES 7
#define HONE_MAX_ROUNDS (UINT32_C(1) << 20)
#define HONE_DEFAULT_REPORT_FD 3
/* Seed + domain tag of the control-channel authentication fold. The trusted
 * parent recomputes the same fold in Python and rejects the launch when the
 * reply diverges, proving the pure trusted process image held both channel
 * ends BEFORE any allocator byte was mapped. */
#define HONE_AUTH_INIT UINT64_C(0xcbf29ce484222325)
#define HONE_AUTH_TAG UINT64_C(0x484f4e4541555448) /* "HONEAUTH" */

static volatile uint64_t hone_sink;

hone_allocator_t hone_mi;

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

/*
 * Distinct per-allocation fill pattern. Every (seed, round, index, nonce)
 * quadruple yields a different 64-bit pattern, so two live blocks can never
 * satisfy each other's canary bytes and a recycled buffer cannot replay a
 * prior block's contents. The trusted parent draws a fresh nonce for every
 * measured sample and delivers it only at clock-start, so the canary bytes
 * (hence the folded checksum) cannot be produced before the measured region
 * begins.
 */
uint64_t hone_pattern(uint64_t seed, uint64_t round, uint64_t index, uint64_t nonce) {
  uint64_t state = seed ^ (nonce * UINT64_C(0xff51afd7ed558ccd)) ^
                   ((round + 1) * UINT64_C(0xa0761d6478bd642f)) ^
                   ((index + 1) * UINT64_C(0xe7037ed1a0b428db));
  if (state == 0) state = UINT64_C(0x8ebc6af09c88c6e3);
  return hone_prng_next(&state);
}

void hone_canary_write(unsigned char* block, size_t size, uint64_t pattern) {
  const size_t head = size < 8 ? size : 8;
  for (size_t j = 0; j < head; ++j) block[j] = (unsigned char)(pattern >> ((j & 7) * 8));
  if (size > 8) {
    const size_t remaining = size - 8;
    const size_t tail = remaining < 8 ? remaining : 8;
    const uint64_t mirrored = ~pattern;
    for (size_t j = 0; j < tail; ++j) {
      block[size - tail + j] = (unsigned char)(mirrored >> ((j & 7) * 8));
    }
  }
}

bool hone_canary_verify(const unsigned char* block, size_t size, uint64_t pattern) {
  const size_t head = size < 8 ? size : 8;
  for (size_t j = 0; j < head; ++j) {
    if (block[j] != (unsigned char)(pattern >> ((j & 7) * 8))) return false;
  }
  if (size > 8) {
    const size_t remaining = size - 8;
    const size_t tail = remaining < 8 ? remaining : 8;
    const uint64_t mirrored = ~pattern;
    for (size_t j = 0; j < tail; ++j) {
      if (block[size - tail + j] != (unsigned char)(mirrored >> ((j & 7) * 8))) return false;
    }
  }
  return true;
}

/*
 * The 64-bit word actually stored at the start of a live block. Defined here,
 * in a translation unit separate from every workload (and never inlined
 * across the boundary: no LTO in the trusted harness build), so the workload
 * checksum folds a value the compiler must obtain with a real load from the
 * allocated memory rather than a constant it can rematerialize from the
 * pattern arithmetic.
 */
uint64_t hone_block_readback(const void* block) {
  uint64_t value;
  memcpy(&value, block, sizeof value);
  return value;
}

static void hone_range_sift(hone_range_t* ranges, size_t start, size_t end) {
  size_t root = start;
  for (;;) {
    size_t child = root * 2 + 1;
    if (child >= end) return;
    if (child + 1 < end && ranges[child].begin < ranges[child + 1].begin) child += 1;
    if (ranges[root].begin >= ranges[child].begin) return;
    const hone_range_t swap = ranges[root];
    ranges[root] = ranges[child];
    ranges[child] = swap;
    root = child;
  }
}

/*
 * Reject any two overlapping live ranges. In-place heapsort by begin, then
 * one adjacent pass: an allocator that hands out one reusable (or partially
 * shared) buffer for several simultaneously-live allocations fails here in
 * EVERY round, timed and validation alike. Deliberately free of libc qsort:
 * an interposable sort or comparator symbol must never sit inside this
 * integrity check.
 */
bool hone_ranges_disjoint(hone_range_t* ranges, size_t count) {
  if (count == 0) return true;
  for (size_t start = count / 2; start-- > 0;) hone_range_sift(ranges, start, count);
  for (size_t end = count; end-- > 1;) {
    const hone_range_t swap = ranges[0];
    ranges[0] = ranges[end];
    ranges[end] = swap;
    hone_range_sift(ranges, 0, end);
  }
  for (size_t i = 0; i < count; ++i) {
    if (ranges[i].begin >= ranges[i].end) return false;
    if (i > 0 && ranges[i - 1].end > ranges[i].begin) return false;
  }
  return true;
}

bool hone_capture_memory(hone_result_t* result) {
  mi_stats_t_decl(stats);
  hone_mi.stats_merge_fn();
  if (!hone_mi.stats_get_fn(&stats) || stats.page_committed.current <= 0 ||
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

static bool parse_u64(const char* text, uint64_t* value) {
  char* end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(text, &end, 10);
  if (errno != 0 || text[0] == '\0' || end == NULL || *end != '\0') return false;
  *value = (uint64_t)parsed;
  return true;
}

static bool hone_write_all(int fd, const char* buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    const ssize_t written = write(fd, buffer + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    if (written == 0) return false;
    offset += (size_t)written;
  }
  return true;
}

/*
 * Read one newline-terminated control token from stdin. The trusted parent
 * process owns this pipe and emits a fresh unpredictable token per sample:
 * the benchmark can only produce a response the parent accepts by blocking
 * here until that token arrives, so the measured region can never be reported
 * before the parent has started its own clock.
 */
static bool hone_read_token(char* buffer, size_t capacity) {
  size_t offset = 0;
  for (;;) {
    char c;
    const ssize_t got = read(0, &c, 1);
    if (got == 1) {
      if (c == '\n') {
        buffer[offset] = '\0';
        return true;
      }
      if (offset + 1 >= capacity) return false;
      buffer[offset++] = c;
      continue;
    }
    if (got < 0 && errno == EINTR) continue;
    return false;
  }
}

/*
 * EXEC-BOUNDARY load: map the allocator shared library and resolve its C ABI.
 * Called only AFTER the control channel authenticated, so any .init_array in
 * the library runs at a trusted-chosen instant inside a pure trusted process
 * image — after the parent has verified this process, and before any sample
 * nonce exists anywhere.
 */
static bool hone_load_allocator(const char* path) {
  void* handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (handle == NULL) return false;
  *(void**)&hone_mi.malloc_fn = dlsym(handle, "mi_malloc");
  *(void**)&hone_mi.zalloc_fn = dlsym(handle, "mi_zalloc");
  *(void**)&hone_mi.free_fn = dlsym(handle, "mi_free");
  *(void**)&hone_mi.collect_fn = dlsym(handle, "mi_collect");
  *(void**)&hone_mi.stats_reset_fn = dlsym(handle, "mi_stats_reset");
  *(void**)&hone_mi.stats_merge_fn = dlsym(handle, "mi_stats_merge");
  *(void**)&hone_mi.stats_get_fn = dlsym(handle, "mi_stats_get");
  return hone_mi.malloc_fn != NULL && hone_mi.zalloc_fn != NULL &&
         hone_mi.free_fn != NULL && hone_mi.collect_fn != NULL &&
         hone_mi.stats_reset_fn != NULL && hone_mi.stats_merge_fn != NULL &&
         hone_mi.stats_get_fn != NULL;
}

int hone_bench_main(const char* workload, int argc, char** argv, hone_workload_fn run) {
  (void)workload;
  uint64_t seed;
  uint64_t rounds_arg;
  if (argc != 4 || !parse_u64(argv[1], &seed) || seed == 0 ||
      !parse_u64(argv[2], &rounds_arg) || rounds_arg == 0 ||
      rounds_arg > HONE_MAX_ROUNDS) {
    return 64;
  }
  const uint32_t rounds = (uint32_t)rounds_arg;

  /*
   * The trusted evaluator owns fd 1 and the wall clock. This benchmark never
   * prints the scored result: it streams work-completion tokens to the report
   * fd the parent handed it, and the parent brackets each measured region with
   * its own monotonic clock across that process boundary.
   */
  int report_fd = HONE_DEFAULT_REPORT_FD;
  const char* report_env = getenv("HONE_REPORT_FD");
  if (report_env != NULL) {
    uint64_t parsed;
    if (!parse_u64(report_env, &parsed) || parsed > (uint64_t)INT_MAX) return 64;
    report_fd = (int)parsed;
  }

  char token[64];
  char line[128];

  /*
   * Control-channel authentication, run by the PURE TRUSTED process image:
   * this executable links no allocator code, and the allocator library is not
   * mapped yet, so no allocator instruction has ever executed in this process
   * when the fold below is produced. The parent verifies the fold and only
   * then treats the channel as live.
   */
  if (!hone_read_token(token, sizeof token) || token[0] != 'A' || token[1] != ' ') return 65;
  uint64_t auth;
  if (!parse_u64(token + 2, &auth)) return 65;
  uint64_t auth_fold = hone_checksum(HONE_AUTH_INIT, auth);
  auth_fold = hone_checksum(auth_fold, HONE_AUTH_TAG);
  int length = snprintf(line, sizeof line, "A %016" PRIx64 "\n", auth_fold);
  if (length <= 0 || (size_t)length >= sizeof line) return 65;
  if (!hone_write_all(report_fd, line, (size_t)length)) return 65;

  /* EXEC BOUNDARY: only now is allocator code mapped into this process. */
  if (!hone_load_allocator(argv[3])) return 66;
  if (!hone_write_all(report_fd, "L\n", 2)) return 66;

  hone_result_t probe = {0};
  if (!run(seed, 1, 0, false, &probe) || probe.operations == 0) return 1;

  uint64_t measured_ops = 0;
  for (size_t sample = 0; sample < HONE_SAMPLES; ++sample) {
    /*
     * The trusted harness owns this loop and calls the candidate allocator
     * through the resolved ABI; the trusted per-round disjointness, canary
     * write/read-back, and nonce-bound checksum (validated by the parent
     * against the pristine reference) already force real distinct writable
     * memory for the whole live set in every sample, so no allocator can skip
     * the allocation work in a timed window. The parent additionally reads the
     * kernel cgroup committed-memory peak during the window as a backstop.
     */
    if (!hone_write_all(report_fd, "R\n", 2)) return 1;
    if (!hone_read_token(token, sizeof token) || token[0] == '\0') return 1;
    /*
     * The go-token IS the sample nonce. It is folded into every allocation's
     * canary pattern below, and every workload folds the 64-bit word it reads
     * back from each live block into the reported checksum, so the value the
     * parent compares against the pristine reference depends on per-block
     * memory written and re-read after the nonce arrives at clock-start.
     */
    uint64_t nonce;
    if (!parse_u64(token, &nonce)) return 1;
    hone_result_t measured = {0};
    if (!run(seed, rounds, nonce, false, &measured) || measured.operations == 0) return 1;
    hone_sink ^= measured.checksum;
    measured_ops = measured.operations;
    length = snprintf(line, sizeof line, "T %s %" PRIu64 " %016" PRIx64 "\n",
                      token, measured.operations, measured.checksum);
    if (length <= 0 || (size_t)length >= sizeof line) return 1;
    if (!hone_write_all(report_fd, line, (size_t)length)) return 1;
  }

  hone_mi.collect_fn(true);
  hone_mi.stats_reset_fn();
  hone_result_t validation = {0};
  if (!run(seed, 1, 0, true, &validation) || !validation.memory_captured ||
      validation.peak_committed == 0 || !isfinite(validation.fragmentation) ||
      validation.fragmentation < 0.0 || validation.fragmentation > 1.0) {
    return 1;
  }
  hone_sink ^= validation.checksum;
  length = snprintf(
    line, sizeof line, "D %016" PRIx64 " %" PRIu64 " %zu %.12f\n",
    validation.checksum, measured_ops, validation.peak_committed,
    validation.fragmentation);
  if (length <= 0 || (size_t)length >= sizeof line) return 1;
  if (!hone_write_all(report_fd, line, (size_t)length)) return 1;
  return 0;
}
