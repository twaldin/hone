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
 *
 * Identity rotation: when the compress mode receives the optional phase
 * argument, every timed iteration first stamps the source buffer with
 * iteration-distinct bytes (see stamp_iteration), so repeated iterations
 * never compress identical content and a content-keyed result cache cannot
 * replay earlier work. Round trips are spot-checked in-process (first,
 * power-of-two, and final iterations), and the trusted evaluator
 * reconstructs the exact first/final iteration content with its own sealed
 * copy of this runner (same phase argument) to validate the emitted frame
 * and the compressed-size gate independently.
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
#define STAMP_STRIDE ((size_t)1 << 16)
#define STAMP_WIDTH ((size_t)8)

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

static uint64_t mix64(uint64_t value) {
    /* splitmix64 finalizer: deterministic, dependency-free bit mixer. */
    value += 0x9E3779B97F4A7C15ULL;
    value = (value ^ (value >> 30)) * 0xBF58476D1CE4E5B9ULL;
    value = (value ^ (value >> 27)) * 0x94D049BB133111EBULL;
    return value ^ (value >> 31);
}

/*
 * Overwrite STAMP_WIDTH bytes at one fixed offset inside every 64 KiB
 * stride. Offsets depend only on (input size, stride), never on the
 * iteration index, so the content of iteration N is a pure function of
 * (payload, N) that the evaluator reproduces exactly with the sealed
 * trusted runner via the phase argument. Stamp values depend on the
 * iteration index, so consecutive timed iterations present distinct bytes
 * inside every zstd block while the workload size and the number of
 * stamped (incompressible) bytes stay constant — the compressibility
 * profile is comparable across iterations.
 */
static void stamp_iteration(unsigned char* data, size_t size, uint64_t iteration) {
    size_t stride;
    for (stride = 0; stride < size; stride += STAMP_STRIDE) {
        size_t length = size - stride;
        size_t offset;
        uint64_t value;
        size_t byte;
        if (length > STAMP_STRIDE) length = STAMP_STRIDE;
        if (length < STAMP_WIDTH) break;
        offset = stride
            + (size_t)(mix64((uint64_t)stride ^ ((uint64_t)size << 24))
                       % (uint64_t)(length - STAMP_WIDTH + 1));
        value = mix64(mix64(iteration) ^ ((uint64_t)stride + 0x517CC1B727220A95ULL));
        for (byte = 0; byte < STAMP_WIDTH; ++byte) {
            data[offset + byte] = (unsigned char)(value >> (byte * 8));
        }
    }
}

static int run_compress(size_t input_size, int level, size_t repetitions, int rotate, size_t phase) {
    unsigned char* source = read_exact_stdin(input_size);
    unsigned char* compressed;
    unsigned char* decoded;
    ZSTD_CCtx* cctx;
    ZSTD_DCtx* dctx;
    size_t capacity;
    size_t produced = 0;
    size_t first = 0;
    size_t index;
    if (source == NULL) return 65;
    capacity = ZSTD_compressBound(input_size);
    compressed = (unsigned char*)malloc(capacity ? capacity : 1);
    decoded = (unsigned char*)malloc(input_size ? input_size : 1);
    cctx = ZSTD_createCCtx();
    dctx = ZSTD_createDCtx();
    if (compressed == NULL || decoded == NULL || cctx == NULL || dctx == NULL) return 71;
    if (ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_compressionLevel, level))) return 71;
    for (index = 0; index < repetitions; ++index) {
        size_t round;
        if (rotate) {
            /* Distinct content per timed iteration: a content-keyed cache
             * of earlier results can never satisfy this iteration. */
            stamp_iteration(source, input_size, (uint64_t)phase + (uint64_t)index);
        }
        produced = ZSTD_compress2(cctx, compressed, capacity, source, input_size);
        if (ZSTD_isError(produced)) return 1;
        if (!rotate) {
            /* Identical input every iteration: sizes must not drift. */
            if (index == 0) first = produced;
            else if (produced != first) return 1;
        }
        /* Spot-check round trips (first iteration, every power of two, and
         * the final iteration) so the timed loop stays dominated by
         * compression work. This in-process check runs candidate-linked
         * code, so it is only a tripwire for broken or stale-cache output —
         * the trusted evaluator independently validates the emitted final
         * frame against its own reconstruction of the final iteration's
         * stamped content and gates its size against the trusted encoder. */
        if (index == 0 || index + 1 == repetitions || (index & (index - 1)) == 0) {
            round = ZSTD_decompressDCtx(dctx, decoded, input_size, compressed, produced);
            if (ZSTD_isError(round) || round != input_size) return 1;
            if (memcmp(decoded, source, input_size) != 0) return 1;
        }
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
    if (argc != 5 && argc != 6) return 64;
    if (!parse_size(argv[2], &input_size) || !parse_size(argv[4], &repetitions)) return 64;
    if (repetitions < 1 || repetitions > MAX_REPS) return 64;
    if (strcmp(argv[1], "compress") == 0) {
        char* end = NULL;
        long level;
        int rotate = 0;
        size_t phase = 0;
        errno = 0;
        level = strtol(argv[3], &end, 10);
        if (errno != 0 || *argv[3] == '\0' || *end != '\0' || (level != 1 && level != 3)) return 64;
        if (argc == 6) {
            if (!parse_size(argv[5], &phase) || phase > MAX_REPS) return 64;
            rotate = 1;
        }
        return run_compress(input_size, (int)level, repetitions, rotate, phase);
    }
    if (strcmp(argv[1], "decompress") == 0) {
        size_t decoded_size;
        if (argc != 5) return 64;
        if (!parse_size(argv[3], &decoded_size)) return 64;
        return run_decompress(input_size, decoded_size, repetitions);
    }
    return 64;
}
