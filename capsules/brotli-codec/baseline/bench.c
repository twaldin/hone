/*
 * Trusted benchmark harness for the brotli-codec capsule.
 * Copyright (c) 2026 Hone contributors. Licensed under MIT.
 *
 * Gaming-resistance design (the broker gives per-eval container isolation
 * only; every measurement guarantee below lives in this trusted harness):
 *
 *  - Timing uses a NON-INTERPOSABLE monotonic clock read through a direct
 *    kernel syscall instruction (svc / syscall). A candidate object linked
 *    into this same executable cannot override the timer with a strong
 *    clock_gettime definition, because the syscall bypasses the PLT and the
 *    dynamic symbol table entirely. The measured throughput is computed in
 *    this trusted code; candidate code never contributes a timestamp.
 *
 *  - The result envelope (compressed size + throughput) is emitted through a
 *    direct-syscall write to a dedicated report fd handed down by the trusted
 *    parent, so a candidate cannot fabricate it by interposing printf/write,
 *    and the parent independently re-derives the compressed size from the byte
 *    stream and validates every round trip out-of-process.
 *
 *  - Encode and decode run as SEPARATE invocations (separate processes chosen
 *    by the parent) so an encoder cannot stash the source in a global for a
 *    colluding decoder; the source never enters the decode process.
 *
 *  - Every measured repetition gets a FRESH source copy and FRESH output
 *    buffer at a fresh address, so pointer- or buffer-identity memoization
 *    cannot transfer work across repetitions.
 */
#define _POSIX_C_SOURCE 200809L
#include "c/include/brotli/decode.h"
#include "c/include/brotli/encode.h"

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define SAMPLE_COUNT 3
#define MAX_REPS ((size_t)1 << 28)
#define HONE_CLOCK_MONOTONIC_RAW 4

static volatile size_t result_sink;

/*
 * Direct, non-interposable kernel syscall boundary. A three-argument helper is
 * all this harness needs (clock_gettime, write). Implemented with the raw
 * instruction so no candidate-defined symbol can intercept it.
 */
#if defined(__aarch64__)
#define HONE_SYS_clock_gettime 113
#define HONE_SYS_write 64
#define HONE_HAVE_DIRECT_SYSCALL 1
static long hone_syscall3(long number, long a0, long a1, long a2) {
  register long x8 __asm__("x8") = number;
  register long x0 __asm__("x0") = a0;
  register long x1 __asm__("x1") = a1;
  register long x2 __asm__("x2") = a2;
  __asm__ volatile("svc #0"
                   : "+r"(x0)
                   : "r"(x8), "r"(x1), "r"(x2)
                   : "memory", "cc");
  return x0;
}
#elif defined(__x86_64__)
#define HONE_SYS_clock_gettime 228
#define HONE_SYS_write 1
#define HONE_HAVE_DIRECT_SYSCALL 1
static long hone_syscall3(long number, long a0, long a1, long a2) {
  long ret;
  register long r10 __asm__("r10") = 0;
  __asm__ volatile("syscall"
                   : "=a"(ret)
                   : "a"(number), "D"(a0), "S"(a1), "d"(a2), "r"(r10)
                   : "rcx", "r11", "memory");
  return ret;
}
#else
#define HONE_HAVE_DIRECT_SYSCALL 0
#endif

struct hone_timespec {
  long tv_sec;
  long tv_nsec;
};

static uint64_t monotonic_ns(void) {
#if HONE_HAVE_DIRECT_SYSCALL
  struct hone_timespec ts;
  ts.tv_sec = 0;
  ts.tv_nsec = 0;
  if (hone_syscall3(HONE_SYS_clock_gettime, HONE_CLOCK_MONOTONIC_RAW,
                    (long)&ts, 0) != 0) {
    _exit(70);
  }
  return (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
#else
  /* Only reached on architectures the capsule never targets; keep the harness
     buildable there. */
  _exit(72);
#endif
}

static void hone_write_all(int fd, const unsigned char* buffer, size_t size) {
  size_t offset = 0;
  while (offset < size) {
#if HONE_HAVE_DIRECT_SYSCALL
    long written = hone_syscall3(HONE_SYS_write, fd, (long)(buffer + offset),
                                 (long)(size - offset));
#else
    ssize_t written = write(fd, buffer + offset, size - offset);
#endif
    if (written <= 0) {
      if (written == -EINTR) continue;
      _exit(71);
    }
    offset += (size_t)written;
  }
}

static int compare_double(const void* left, const void* right) {
  double a = *(const double*)left;
  double b = *(const double*)right;
  return (a > b) - (a < b);
}

static unsigned char* read_exact_stdin(size_t size) {
  unsigned char* data = (unsigned char*)malloc(size ? size : 1);
  size_t offset = 0;
  if (data == NULL) return NULL;
  while (offset < size) {
    ssize_t got = read(STDIN_FILENO, data + offset, size - offset);
    if (got < 0) {
      if (errno == EINTR) continue;
      free(data);
      return NULL;
    }
    if (got == 0) {
      free(data);
      return NULL;
    }
    offset += (size_t)got;
  }
  {
    unsigned char extra;
    ssize_t got;
    do {
      got = read(STDIN_FILENO, &extra, 1);
    } while (got < 0 && errno == EINTR);
    if (got != 0) {
      free(data);
      return NULL;
    }
  }
  return data;
}

static double throughput_mib(size_t bytes, size_t repetitions, uint64_t elapsed_ns) {
  return ((double)bytes * (double)repetitions * 1000000000.0) /
         ((double)elapsed_ns * 1048576.0);
}

/* Append a decimal unsigned integer to a byte buffer. Returns new length. */
static size_t append_uint(unsigned char* out, size_t length, uint64_t value) {
  char digits[20];
  int count = 0;
  do {
    digits[count++] = (char)('0' + (int)(value % 10));
    value /= 10;
  } while (value != 0);
  while (count > 0) {
    out[length++] = (unsigned char)digits[--count];
  }
  return length;
}

/* Emit "<field0> <field1> ...\n" via the non-interposable write boundary. */
static void emit_report(int fd, const uint64_t* fields, int field_count) {
  unsigned char line[128];
  size_t length = 0;
  int i;
  for (i = 0; i < field_count; ++i) {
    if (i != 0) line[length++] = ' ';
    length = append_uint(line, length, fields[i]);
  }
  line[length++] = '\n';
  hone_write_all(fd, line, length);
}

static uint64_t throughput_to_micro(double mib_s) {
  if (!(mib_s > 0.0)) return 0;
  return (uint64_t)(mib_s * 1000000.0 + 0.5);
}

/*
 * Measure codec throughput over FRESH buffers, timing only the codec call
 * itself: each repetition allocates fresh source/output buffers and warms the
 * source with a copy OUTSIDE the timed region, so buffer- or pointer-identity
 * memoization cannot transfer work across repetitions while the reported
 * throughput still reflects pure codec cost. `work` returns the codec-only
 * elapsed nanoseconds, or UINT64_MAX on failure. The median of SAMPLE_COUNT
 * bursts is reported so transient scheduling noise cannot dominate.
 */
typedef uint64_t (*rep_fn)(void* ctx);

static int measure(rep_fn work, void* ctx, size_t bytes, uint64_t target_ns,
                   double* median_mib_s) {
  double samples[SAMPLE_COUNT];
  int sample;
  for (sample = 0; sample < SAMPLE_COUNT; ++sample) {
    uint64_t elapsed_ns = 0;
    size_t repetitions = 0;
    while (repetitions < MAX_REPS) {
      uint64_t dt = work(ctx);
      if (dt == UINT64_MAX) return 0;
      elapsed_ns += dt;
      repetitions += 1;
      if (elapsed_ns >= target_ns) break;
      /* Guard against codec calls below the clock resolution: never spin to
         MAX_REPS accumulating zero elapsed time. */
      if (elapsed_ns == 0 && repetitions >= 1000000) break;
    }
    if (elapsed_ns == 0) elapsed_ns = 1;
    samples[sample] = throughput_mib(bytes, repetitions, elapsed_ns);
  }
  qsort(samples, SAMPLE_COUNT, sizeof(samples[0]), compare_double);
  *median_mib_s = samples[SAMPLE_COUNT / 2];
  return 1;
}

struct compress_ctx {
  const unsigned char* source;
  size_t source_size;
  size_t compressed_capacity;
  size_t expected_size;
  int quality;
};

static uint64_t compress_rep(void* raw) {
  struct compress_ctx* ctx = (struct compress_ctx*)raw;
  unsigned char* source_copy = (unsigned char*)malloc(ctx->source_size);
  unsigned char* output = (unsigned char*)malloc(ctx->compressed_capacity);
  size_t encoded_size = ctx->compressed_capacity;
  uint64_t elapsed = UINT64_MAX;
  uint64_t started;
  if (source_copy == NULL || output == NULL) goto done;
  memcpy(source_copy, ctx->source, ctx->source_size);
  started = monotonic_ns();
  if (BrotliEncoderCompress(ctx->quality, BROTLI_DEFAULT_WINDOW,
                            BROTLI_MODE_GENERIC, ctx->source_size, source_copy,
                            &encoded_size, output)) {
    elapsed = monotonic_ns() - started;
    if (encoded_size != ctx->expected_size) {
      elapsed = UINT64_MAX;
    } else {
      result_sink ^= encoded_size ^ output[encoded_size - 1];
    }
  }
done:
  free(output);
  free(source_copy);
  return elapsed;
}

struct decompress_ctx {
  const unsigned char* compressed;
  size_t compressed_size;
  size_t decoded_capacity;
};

static uint64_t decompress_rep(void* raw) {
  struct decompress_ctx* ctx = (struct decompress_ctx*)raw;
  unsigned char* compressed_copy = (unsigned char*)malloc(ctx->compressed_size);
  unsigned char* output = (unsigned char*)malloc(ctx->decoded_capacity);
  size_t decoded_size = ctx->decoded_capacity;
  uint64_t elapsed = UINT64_MAX;
  uint64_t started;
  if (compressed_copy == NULL || output == NULL) goto done;
  memcpy(compressed_copy, ctx->compressed, ctx->compressed_size);
  started = monotonic_ns();
  if (BrotliDecoderDecompress(ctx->compressed_size, compressed_copy,
                              &decoded_size, output) ==
      BROTLI_DECODER_RESULT_SUCCESS) {
    elapsed = monotonic_ns() - started;
    if (decoded_size != ctx->decoded_capacity) {
      elapsed = UINT64_MAX;
    } else {
      result_sink ^= decoded_size ^ output[decoded_size - 1];
    }
  }
done:
  free(output);
  free(compressed_copy);
  return elapsed;
}

static unsigned long parse_bounded(const char* text, unsigned long low,
                                   unsigned long high, int* ok) {
  char* end = NULL;
  unsigned long value;
  errno = 0;
  value = strtoul(text, &end, 10);
  if (errno != 0 || *text == '\0' || *end != '\0' || value < low ||
      value > high) {
    *ok = 0;
    return 0;
  }
  *ok = 1;
  return value;
}

static unsigned long long parse_size(const char* text, int* ok) {
  char* end = NULL;
  unsigned long long value;
  errno = 0;
  value = strtoull(text, &end, 10);
  if (errno != 0 || *text == '\0' || *end != '\0' || value == 0 ||
      value > SIZE_MAX) {
    *ok = 0;
    return 0;
  }
  *ok = 1;
  return value;
}

/*
 * Modes:
 *   c <report_fd> <source_size> <quality> <target_ms>
 *       stdin: source bytes; stdout: canonical compressed stream;
 *       report: "<compressed_size> <compression_micro_mib_s>".
 *   d <report_fd> <decoded_size> <compressed_size> <quality> <target_ms>
 *       stdin: compressed bytes; stdout: canonical decoded stream;
 *       report: "<decompression_micro_mib_s>".
 */
int main(int argc, char** argv) {
  int ok = 0;
  int report_fd;
  long quality;
  unsigned long target_ms;
  uint64_t target_ns;

  if (argc < 2) return 64;

  if (strcmp(argv[1], "c") == 0) {
    unsigned long long source_size;
    unsigned char* source = NULL;
    unsigned char* compressed = NULL;
    size_t compressed_capacity;
    size_t compressed_size;
    double compression_mib_s = 0.0;
    struct compress_ctx ctx;
    uint64_t fields[2];
    int good;

    if (argc != 6) return 64;
    report_fd = (int)parse_bounded(argv[2], 3, 1023, &good);
    if (!good) return 64;
    source_size = parse_size(argv[3], &good);
    if (!good) return 64;
    quality = (long)parse_bounded(argv[4], 0, 11, &good);
    if (!good || (quality != 4 && quality != 9)) return 64;
    target_ms = parse_bounded(argv[5], 20, 5000, &good);
    if (!good) return 64;
    target_ns = (uint64_t)target_ms * UINT64_C(1000000);

    source = read_exact_stdin((size_t)source_size);
    if (source == NULL) goto compress_cleanup;
    compressed_capacity = BrotliEncoderMaxCompressedSize((size_t)source_size);
    if (compressed_capacity == 0) goto compress_cleanup;
    compressed = (unsigned char*)malloc(compressed_capacity);
    if (compressed == NULL) goto compress_cleanup;

    compressed_size = compressed_capacity;
    if (!BrotliEncoderCompress((int)quality, BROTLI_DEFAULT_WINDOW,
                               BROTLI_MODE_GENERIC, (size_t)source_size, source,
                               &compressed_size, compressed)) {
      goto compress_cleanup;
    }

    ctx.source = source;
    ctx.source_size = (size_t)source_size;
    ctx.compressed_capacity = compressed_capacity;
    ctx.expected_size = compressed_size;
    ctx.quality = (int)quality;
    if (!measure(compress_rep, &ctx, (size_t)source_size, target_ns,
                 &compression_mib_s)) {
      goto compress_cleanup;
    }

    hone_write_all(STDOUT_FILENO, compressed, compressed_size);
    fields[0] = (uint64_t)compressed_size;
    fields[1] = throughput_to_micro(compression_mib_s);
    emit_report(report_fd, fields, 2);
    ok = 1;

  compress_cleanup:
    free(compressed);
    free(source);
    return ok ? 0 : 1;
  }

  if (strcmp(argv[1], "d") == 0) {
    unsigned long long decoded_size;
    unsigned long long compressed_size;
    unsigned char* compressed = NULL;
    unsigned char* decoded = NULL;
    size_t produced;
    double decompression_mib_s = 0.0;
    struct decompress_ctx ctx;
    uint64_t fields[1];
    int good;

    if (argc != 7) return 64;
    report_fd = (int)parse_bounded(argv[2], 3, 1023, &good);
    if (!good) return 64;
    decoded_size = parse_size(argv[3], &good);
    if (!good) return 64;
    compressed_size = parse_size(argv[4], &good);
    if (!good) return 64;
    quality = (long)parse_bounded(argv[5], 0, 11, &good);
    if (!good || (quality != 4 && quality != 9)) return 64;
    target_ms = parse_bounded(argv[6], 20, 5000, &good);
    if (!good) return 64;
    target_ns = (uint64_t)target_ms * UINT64_C(1000000);

    compressed = read_exact_stdin((size_t)compressed_size);
    if (compressed == NULL) goto decompress_cleanup;
    decoded = (unsigned char*)malloc((size_t)decoded_size);
    if (decoded == NULL) goto decompress_cleanup;

    produced = (size_t)decoded_size;
    if (BrotliDecoderDecompress((size_t)compressed_size, compressed, &produced,
                                decoded) != BROTLI_DECODER_RESULT_SUCCESS ||
        produced != (size_t)decoded_size) {
      goto decompress_cleanup;
    }

    ctx.compressed = compressed;
    ctx.compressed_size = (size_t)compressed_size;
    ctx.decoded_capacity = (size_t)decoded_size;
    if (!measure(decompress_rep, &ctx, (size_t)decoded_size, target_ns,
                 &decompression_mib_s)) {
      goto decompress_cleanup;
    }

    hone_write_all(STDOUT_FILENO, decoded, (size_t)decoded_size);
    fields[0] = throughput_to_micro(decompression_mib_s);
    emit_report(report_fd, fields, 1);
    ok = 1;

  decompress_cleanup:
    free(decoded);
    free(compressed);
    return ok ? 0 : 1;
  }

  return 64;
}
