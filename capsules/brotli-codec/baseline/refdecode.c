/*
 * Protected reference Brotli decoder for the brotli-codec capsule.
 * Copyright (c) 2026 Hone contributors. Licensed under MIT.
 *
 * Compiled by the trusted evaluator from the PRISTINE baseline c/common and
 * c/dec sources (never from candidate code) and used to independently decode
 * every stream the candidate encoder emits. A candidate encoder/decoder pair
 * therefore cannot collude on a non-Brotli format: only genuine Brotli
 * streams that decode to the exact expected plaintext are accepted.
 *
 * Usage: hone-ref-decode <compressed_size> <decoded_size>
 *   stdin:  exactly compressed_size bytes
 *   stdout: exactly decoded_size decoded bytes
 * Exit 0 iff the stream is valid Brotli producing exactly decoded_size bytes.
 */
#define _POSIX_C_SOURCE 200809L
#include "c/include/brotli/decode.h"

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_INPUT ((size_t)1 << 27)

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

static size_t parse_size(const char* text, int* ok) {
  char* end = NULL;
  unsigned long long value;
  errno = 0;
  value = strtoull(text, &end, 10);
  if (errno != 0 || *text == '\0' || *end != '\0' || value == 0 ||
      value > MAX_INPUT) {
    *ok = 0;
    return 0;
  }
  *ok = 1;
  return (size_t)value;
}

int main(int argc, char** argv) {
  int ok = 0;
  size_t compressed_size;
  size_t decoded_size;
  size_t produced;
  unsigned char* compressed = NULL;
  unsigned char* output = NULL;

  if (argc != 3) return 64;
  compressed_size = parse_size(argv[1], &ok);
  if (!ok) return 64;
  decoded_size = parse_size(argv[2], &ok);
  if (!ok) return 64;

  ok = 0;
  compressed = (unsigned char*)malloc(compressed_size);
  output = (unsigned char*)malloc(decoded_size);
  produced = decoded_size;
  if (compressed != NULL && output != NULL &&
      read_exact(compressed, compressed_size) && expect_stdin_eof() &&
      BrotliDecoderDecompress(compressed_size, compressed, &produced,
                              output) == BROTLI_DECODER_RESULT_SUCCESS &&
      produced == decoded_size && write_all(STDOUT_FILENO, output, produced)) {
    ok = 1;
  }
  free(output);
  free(compressed);
  return ok ? 0 : 1;
}
