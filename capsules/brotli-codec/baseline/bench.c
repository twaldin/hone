/*
 * Trusted codec runner for the brotli-codec capsule.
 * Copyright (c) 2026 Hone contributors. Licensed under MIT.
 *
 * Gaming-resistance design (the broker gives per-eval container isolation
 * only; the measurement guarantees live in the trusted evaluator process):
 *
 *  - This binary performs NO timing and holds NO report channel. Throughput
 *    is measured by the trusted evaluator (a separate root process) as the
 *    wall-clock lifetime of each runner process, so candidate code linked
 *    into this executable has no timing value or result envelope to write.
 *
 *  - Every invocation processes a batch of IDENTITY-DISTINCT inputs supplied
 *    by the evaluator (per-iteration rotated/perturbed content), so repeated
 *    timed work cannot be memoized or replayed within or across processes.
 *
 *  - The only output is the raw codec byte stream on stdout. The evaluator
 *    independently validates every emitted stream out of process (candidate
 *    encoder output is decoded by a protected reference decoder built from
 *    the trusted baseline; candidate decoder output is byte-compared against
 *    the exact expected plaintext), so fabricated output cannot pass.
 *
 *  - Encode and decode run as SEPARATE invocations under distinct uids
 *    chosen by the evaluator, so an encoder cannot stash source bytes in a
 *    global for a colluding decoder; the source never enters a decode
 *    process.
 *
 *  - Each iteration copies its input into a FRESH buffer and produces output
 *    in a FRESH buffer at a fresh address.
 */
#define _POSIX_C_SOURCE 200809L
#include "c/include/brotli/decode.h"
#include "c/include/brotli/encode.h"

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_COUNT 64
#define MAX_INPUT ((size_t)1 << 26)
#define MAX_STREAM ((size_t)1 << 27)

static int read_exact(unsigned char* data, size_t size) {
  size_t offset = 0;
  while (offset < size) {
    ssize_t got = read(STDIN_FILENO, data + offset, size - offset);
    if (got < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    if (got == 0) return 0;
    offset += (size_t)got;
  }
  return 1;
}

static int expect_stdin_eof(void) {
  unsigned char extra;
  ssize_t got;
  do {
    got = read(STDIN_FILENO, &extra, 1);
  } while (got < 0 && errno == EINTR);
  return got == 0;
}

static int write_all(int fd, const unsigned char* buffer, size_t size) {
  size_t offset = 0;
  while (offset < size) {
    ssize_t written = write(fd, buffer + offset, size - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    if (written == 0) return 0;
    offset += (size_t)written;
  }
  return 1;
}

static void store_le64(unsigned char* out, uint64_t value) {
  int i;
  for (i = 0; i < 8; ++i) {
    out[i] = (unsigned char)(value >> (8 * i));
  }
}

static uint64_t load_le64(const unsigned char* in) {
  uint64_t value = 0;
  int i;
  for (i = 0; i < 8; ++i) {
    value |= (uint64_t)in[i] << (8 * i);
  }
  return value;
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

/*
 * Modes:
 *   c <count> <source_size> <quality>
 *       stdin:  count * source_size bytes (concatenated distinct inputs)
 *       stdout: per input, [8-byte LE compressed_size][compressed bytes]
 *   d <count> <decoded_size>
 *       stdin:  per input, [8-byte LE stream_size][stream bytes]
 *       stdout: count * decoded_size decoded bytes
 */
int main(int argc, char** argv) {
  int good = 0;
  unsigned long count;
  size_t i;

  if (argc < 3) return 64;
  count = parse_bounded(argv[2], 1, MAX_COUNT, &good);
  if (!good) return 64;

  if (strcmp(argv[1], "c") == 0) {
    unsigned long source_size;
    unsigned long quality;
    unsigned char* inputs = NULL;
    size_t total;
    int ok = 0;

    if (argc != 5) return 64;
    source_size = parse_bounded(argv[3], 1, MAX_INPUT, &good);
    if (!good) return 64;
    quality = parse_bounded(argv[4], 0, 11, &good);
    if (!good || (quality != 4 && quality != 9)) return 64;
    if ((size_t)count > MAX_STREAM / (size_t)source_size) return 64;
    total = (size_t)count * (size_t)source_size;

    inputs = (unsigned char*)malloc(total);
    if (inputs == NULL) return 1;
    if (!read_exact(inputs, total) || !expect_stdin_eof()) {
      free(inputs);
      return 1;
    }

    ok = 1;
    for (i = 0; i < count && ok; ++i) {
      unsigned char* source = (unsigned char*)malloc((size_t)source_size);
      size_t capacity = BrotliEncoderMaxCompressedSize((size_t)source_size);
      unsigned char* output = capacity ? (unsigned char*)malloc(capacity) : NULL;
      size_t encoded_size = capacity;
      unsigned char header[8];
      ok = 0;
      if (source != NULL && output != NULL) {
        memcpy(source, inputs + i * (size_t)source_size, (size_t)source_size);
        if (BrotliEncoderCompress((int)quality, BROTLI_DEFAULT_WINDOW,
                                  BROTLI_MODE_GENERIC, (size_t)source_size,
                                  source, &encoded_size, output) &&
            encoded_size > 0) {
          store_le64(header, (uint64_t)encoded_size);
          if (write_all(STDOUT_FILENO, header, 8) &&
              write_all(STDOUT_FILENO, output, encoded_size)) {
            ok = 1;
          }
        }
      }
      free(output);
      free(source);
    }
    free(inputs);
    return ok ? 0 : 1;
  }

  if (strcmp(argv[1], "d") == 0) {
    unsigned long decoded_size;
    unsigned char** streams = NULL;
    size_t* stream_sizes = NULL;
    int ok = 1;

    if (argc != 4) return 64;
    decoded_size = parse_bounded(argv[3], 1, MAX_INPUT, &good);
    if (!good) return 64;

    streams = (unsigned char**)calloc((size_t)count, sizeof(*streams));
    stream_sizes = (size_t*)calloc((size_t)count, sizeof(*stream_sizes));
    if (streams == NULL || stream_sizes == NULL) ok = 0;

    for (i = 0; i < count && ok; ++i) {
      unsigned char header[8];
      uint64_t size;
      ok = 0;
      if (read_exact(header, 8)) {
        size = load_le64(header);
        if (size > 0 && size <= MAX_STREAM) {
          streams[i] = (unsigned char*)malloc((size_t)size);
          if (streams[i] != NULL && read_exact(streams[i], (size_t)size)) {
            stream_sizes[i] = (size_t)size;
            ok = 1;
          }
        }
      }
    }
    if (ok && !expect_stdin_eof()) ok = 0;

    for (i = 0; i < count && ok; ++i) {
      unsigned char* compressed = (unsigned char*)malloc(stream_sizes[i]);
      unsigned char* output = (unsigned char*)malloc((size_t)decoded_size);
      size_t produced = (size_t)decoded_size;
      ok = 0;
      if (compressed != NULL && output != NULL) {
        memcpy(compressed, streams[i], stream_sizes[i]);
        if (BrotliDecoderDecompress(stream_sizes[i], compressed, &produced,
                                    output) == BROTLI_DECODER_RESULT_SUCCESS &&
            produced == (size_t)decoded_size &&
            write_all(STDOUT_FILENO, output, produced)) {
          ok = 1;
        }
      }
      free(output);
      free(compressed);
    }

    if (streams != NULL) {
      for (i = 0; i < count; ++i) free(streams[i]);
    }
    free(streams);
    free(stream_sizes);
    return ok ? 0 : 1;
  }

  return 64;
}
