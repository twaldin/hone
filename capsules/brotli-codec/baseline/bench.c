/*
 * Trusted benchmark harness for the brotli-codec capsule.
 * Copyright (c) 2026 Hone contributors. Licensed under MIT.
 */
#define _POSIX_C_SOURCE 200809L
#include "c/include/brotli/decode.h"
#include "c/include/brotli/encode.h"

#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define SAMPLE_COUNT 3
#define MAX_REPS ((size_t)1 << 28)

static volatile size_t result_sink;

static uint64_t monotonic_ns(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC_RAW, &ts) != 0) {
    perror("clock_gettime");
    exit(70);
  }
  return (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
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

static int benchmark_compress(
    unsigned char* compressed,
    size_t compressed_capacity,
    const unsigned char* source,
    size_t source_size,
    int quality,
    size_t expected_size,
    uint64_t target_ns,
    double* median_mib_s) {
  double samples[SAMPLE_COUNT];
  int sample;
  for (sample = 0; sample < SAMPLE_COUNT; ++sample) {
    size_t repetitions = 1;
    uint64_t elapsed_ns;
    for (;;) {
      size_t index;
      uint64_t started = monotonic_ns();
      for (index = 0; index < repetitions; ++index) {
        size_t encoded_size = compressed_capacity;
        BROTLI_BOOL result = BrotliEncoderCompress(
            quality, BROTLI_DEFAULT_WINDOW, BROTLI_MODE_GENERIC,
            source_size, source, &encoded_size, compressed);
        if (!result || encoded_size != expected_size) return 0;
        result_sink ^= encoded_size;
      }
      elapsed_ns = monotonic_ns() - started;
      if (elapsed_ns >= target_ns || repetitions >= MAX_REPS) break;
      if (elapsed_ns == 0) repetitions *= 8;
      else {
        double scale = (double)target_ns / (double)elapsed_ns;
        size_t next = (size_t)((double)repetitions * (scale > 8.0 ? 8.0 : scale * 1.15));
        repetitions = next > repetitions ? next : repetitions + 1;
      }
      if (repetitions > MAX_REPS) repetitions = MAX_REPS;
    }
    samples[sample] = throughput_mib(source_size, repetitions, elapsed_ns);
  }
  qsort(samples, SAMPLE_COUNT, sizeof(samples[0]), compare_double);
  *median_mib_s = samples[SAMPLE_COUNT / 2];
  return 1;
}

static int benchmark_decompress(
    unsigned char* decoded,
    size_t decoded_capacity,
    const unsigned char* compressed,
    size_t compressed_size,
    const unsigned char* expected,
    uint64_t target_ns,
    double* median_mib_s) {
  double samples[SAMPLE_COUNT];
  int sample;
  for (sample = 0; sample < SAMPLE_COUNT; ++sample) {
    size_t repetitions = 1;
    uint64_t elapsed_ns;
    for (;;) {
      size_t index;
      uint64_t started = monotonic_ns();
      for (index = 0; index < repetitions; ++index) {
        size_t decoded_size = decoded_capacity;
        BrotliDecoderResult result = BrotliDecoderDecompress(
            compressed_size, compressed, &decoded_size, decoded);
        if (result != BROTLI_DECODER_RESULT_SUCCESS || decoded_size != decoded_capacity) return 0;
        result_sink ^= decoded_size;
      }
      elapsed_ns = monotonic_ns() - started;
      if (elapsed_ns >= target_ns || repetitions >= MAX_REPS) break;
      if (elapsed_ns == 0) repetitions *= 8;
      else {
        double scale = (double)target_ns / (double)elapsed_ns;
        size_t next = (size_t)((double)repetitions * (scale > 8.0 ? 8.0 : scale * 1.15));
        repetitions = next > repetitions ? next : repetitions + 1;
      }
      if (repetitions > MAX_REPS) repetitions = MAX_REPS;
    }
    if (memcmp(decoded, expected, decoded_capacity) != 0) return 0;
    samples[sample] = throughput_mib(decoded_capacity, repetitions, elapsed_ns);
  }
  qsort(samples, SAMPLE_COUNT, sizeof(samples[0]), compare_double);
  *median_mib_s = samples[SAMPLE_COUNT / 2];
  return 1;
}

int main(int argc, char** argv) {
  char* end = NULL;
  unsigned long long parsed_size;
  long quality;
  unsigned long target_ms;
  unsigned char* source = NULL;
  unsigned char* compressed = NULL;
  unsigned char* decoded = NULL;
  size_t compressed_capacity;
  size_t compressed_size;
  size_t decoded_size;
  double compression_mib_s;
  double decompression_mib_s;
  int ok = 0;

  if (argc != 4) return 64;
  errno = 0;
  parsed_size = strtoull(argv[1], &end, 10);
  if (errno != 0 || *argv[1] == '\0' || *end != '\0' || parsed_size == 0 || parsed_size > SIZE_MAX) return 64;
  errno = 0;
  quality = strtol(argv[2], &end, 10);
  if (errno != 0 || *argv[2] == '\0' || *end != '\0' || (quality != 4 && quality != 9)) return 64;
  errno = 0;
  target_ms = strtoul(argv[3], &end, 10);
  if (errno != 0 || *argv[3] == '\0' || *end != '\0' || target_ms < 20 || target_ms > 5000) return 64;

  source = read_exact_stdin((size_t)parsed_size);
  if (source == NULL) goto cleanup;
  compressed_capacity = BrotliEncoderMaxCompressedSize((size_t)parsed_size);
  if (compressed_capacity == 0) goto cleanup;
  compressed = (unsigned char*)malloc(compressed_capacity);
  decoded = (unsigned char*)malloc((size_t)parsed_size);
  if (compressed == NULL || decoded == NULL) goto cleanup;

  compressed_size = compressed_capacity;
  if (!BrotliEncoderCompress(
          (int)quality, BROTLI_DEFAULT_WINDOW, BROTLI_MODE_GENERIC,
          (size_t)parsed_size, source, &compressed_size, compressed)) goto cleanup;
  decoded_size = (size_t)parsed_size;
  if (BrotliDecoderDecompress(compressed_size, compressed, &decoded_size, decoded) !=
          BROTLI_DECODER_RESULT_SUCCESS ||
      decoded_size != (size_t)parsed_size || memcmp(decoded, source, (size_t)parsed_size) != 0) goto cleanup;

  if (!benchmark_compress(compressed, compressed_capacity, source, (size_t)parsed_size,
                          (int)quality, compressed_size,
                          (uint64_t)target_ms * UINT64_C(1000000), &compression_mib_s)) goto cleanup;
  if (!benchmark_decompress(decoded, (size_t)parsed_size, compressed, compressed_size, source,
                            (uint64_t)target_ms * UINT64_C(1000000), &decompression_mib_s)) goto cleanup;

  printf("ok %zu %.9f %.9f %zu\n", compressed_size, compression_mib_s, decompression_mib_s, result_sink);
  ok = 1;

cleanup:
  free(decoded);
  free(compressed);
  free(source);
  return ok ? 0 : 1;
}
