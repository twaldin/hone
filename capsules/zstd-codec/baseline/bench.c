/*
 * Benchmark runner for the zstd-codec capsule.
 * Copyright (c) 2026 Hone contributors. Licensed under BSD-3-Clause.
 *
 * Robustness model: this runner is linked against the candidate-built
 * libzstd.a, so NOTHING inside this process is treated as trusted by the
 * evaluator. The runner deliberately contains no clock reads at all — every
 * duration is measured by the trusted evaluator parent process around the
 * whole runner lifetime, so a strong timer symbol in a candidate object can
 * never interpose the measurement. The runner only performs the requested
 * number of repetitions and emits the raw result bytes on stdout; the
 * evaluator independently validates those bytes (trusted-reference round
 * trip for compression, byte-exact comparison for decompression) and
 * enforces every gate outside this process.
 */
#define _POSIX_C_SOURCE 200809L
#include "lib/zstd.h"
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_REPS ((size_t)1 << 24)

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

static int write_all_stdout(const unsigned char* data, size_t size) {
    size_t offset = 0;
    while (offset < size) {
        ssize_t put = write(STDOUT_FILENO, data + offset, size - offset);
        if (put < 0) {
            if (errno == EINTR) continue;
            return 0;
        }
        offset += (size_t)put;
    }
    return 1;
}

static int parse_size(const char* text, size_t* out) {
    char* end = NULL;
    unsigned long long parsed;
    errno = 0;
    parsed = strtoull(text, &end, 10);
    if (errno != 0 || *text == '\0' || *end != '\0' || parsed > SIZE_MAX) return 0;
    *out = (size_t)parsed;
    return 1;
}

static int run_compress(size_t input_size, int level, size_t repetitions) {
    unsigned char* source = read_exact_stdin(input_size);
    unsigned char* compressed;
    ZSTD_CCtx* cctx;
    size_t capacity;
    size_t produced = 0;
    size_t first = 0;
    size_t index;
    if (source == NULL) return 65;
    capacity = ZSTD_compressBound(input_size);
    compressed = (unsigned char*)malloc(capacity ? capacity : 1);
    cctx = ZSTD_createCCtx();
    if (compressed == NULL || cctx == NULL) return 71;
    if (ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_compressionLevel, level))) return 71;
    for (index = 0; index < repetitions; ++index) {
        produced = ZSTD_compress2(cctx, compressed, capacity, source, input_size);
        if (ZSTD_isError(produced)) return 1;
        if (index == 0) first = produced;
        else if (produced != first) return 1;
    }
    if (!write_all_stdout(compressed, produced)) return 74;
    return 0;
}

static int run_decompress(size_t input_size, size_t decoded_size, size_t repetitions) {
    unsigned char* frame = read_exact_stdin(input_size);
    unsigned char* decoded;
    ZSTD_DCtx* dctx;
    size_t produced = 0;
    size_t index;
    if (frame == NULL) return 65;
    decoded = (unsigned char*)malloc(decoded_size ? decoded_size : 1);
    dctx = ZSTD_createDCtx();
    if (decoded == NULL || dctx == NULL) return 71;
    for (index = 0; index < repetitions; ++index) {
        produced = ZSTD_decompressDCtx(dctx, decoded, decoded_size, frame, input_size);
        if (ZSTD_isError(produced) || produced != decoded_size) return 1;
    }
    if (!write_all_stdout(decoded, produced)) return 74;
    return 0;
}

int main(int argc, char** argv) {
    size_t input_size;
    size_t repetitions;
    if (argc != 5) return 64;
    if (!parse_size(argv[2], &input_size) || !parse_size(argv[4], &repetitions)) return 64;
    if (repetitions < 1 || repetitions > MAX_REPS) return 64;
    if (strcmp(argv[1], "compress") == 0) {
        char* end = NULL;
        long level;
        errno = 0;
        level = strtol(argv[3], &end, 10);
        if (errno != 0 || *argv[3] == '\0' || *end != '\0' || (level != 1 && level != 3)) return 64;
        return run_compress(input_size, (int)level, repetitions);
    }
    if (strcmp(argv[1], "decompress") == 0) {
        size_t decoded_size;
        if (!parse_size(argv[3], &decoded_size)) return 64;
        return run_decompress(input_size, decoded_size, repetitions);
    }
    return 64;
}
