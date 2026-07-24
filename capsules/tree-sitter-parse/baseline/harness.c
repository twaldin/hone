#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "tree_sitter/api.h"

extern const TSLanguage *tree_sitter_javascript(void);
extern const TSLanguage *tree_sitter_rust(void);
extern const TSLanguage *tree_sitter_python(void);

typedef struct {
  char *data;
  uint32_t length;
} Buffer;

/*
 * Robustness: this executable links the mutable runtime under lib/src, so any
 * libc symbol (printf, puts, exit, ...) can be overridden by candidate code.
 * Every trusted result byte and every process exit therefore goes through the
 * direct pinned linux/arm64 kernel syscalls below, never through symbols the
 * candidate objects could interpose.
 */
static _Noreturn void raw_exit(int code) {
#if !defined(__linux__) || !defined(__aarch64__)
#error "trusted exit is pinned to linux/arm64"
#endif
  for (;;) {
    register long syscall_number __asm__("x8") = 94; /* exit_group */
    register long argument_0 __asm__("x0") = code;
    __asm__ volatile("svc 0" : : "r"(argument_0), "r"(syscall_number) : "memory", "cc");
  }
}

static void raw_write(int fd, const char *data, size_t length) {
  while (length > 0) {
    register long syscall_number __asm__("x8") = 64; /* write */
    register long argument_0 __asm__("x0") = fd;
    register long argument_1 __asm__("x1") = (long)data;
    register long argument_2 __asm__("x2") = (long)length;
    __asm__ volatile(
        "svc 0"
        : "+r"(argument_0)
        : "r"(argument_1), "r"(argument_2), "r"(syscall_number)
        : "memory", "cc");
    if (argument_0 == -EINTR) continue;
    if (argument_0 <= 0) raw_exit(2);
    data += argument_0;
    length -= (size_t)argument_0;
  }
}

static _Noreturn void fail(const char *message) {
  size_t length = 0;
  while (message[length] != '\0') length++;
  raw_write(2, message, length);
  raw_write(2, "\n", 1);
  raw_exit(2);
}

static size_t append_text(char *buffer, size_t offset, size_t capacity, const char *text) {
  while (*text != '\0') {
    if (offset >= capacity) fail("trusted emit overflow");
    buffer[offset++] = *text++;
  }
  return offset;
}

static size_t append_u64(char *buffer, size_t offset, size_t capacity, uint64_t value) {
  char digits[20];
  size_t count = 0;
  do {
    digits[count++] = (char)('0' + (value % 10));
    value /= 10;
  } while (value > 0);
  while (count > 0) {
    if (offset >= capacity) fail("trusted emit overflow");
    buffer[offset++] = digits[--count];
  }
  return offset;
}

static Buffer read_file(const char *path) {
  FILE *file = fopen(path, "rb");
  if (!file) fail("cannot open input");
  if (fseek(file, 0, SEEK_END) != 0) fail("cannot seek input");
  long size = ftell(file);
  if (size < 0 || (unsigned long)size > UINT32_MAX) fail("invalid input size");
  rewind(file);
  char *data = malloc((size_t)size + 1);
  if (!data) fail("out of memory");
  if (size > 0 && fread(data, 1, (size_t)size, file) != (size_t)size) fail("cannot read input");
  if (fclose(file) != 0) fail("cannot close input");
  data[size] = '\0';
  return (Buffer){data, (uint32_t)size};
}

static void write_file(const char *directory, const char *name, const char *data, size_t size) {
  char path[4096];
  int length = snprintf(path, sizeof path, "%s/%s", directory, name);
  if (length < 0 || (size_t)length >= sizeof path) fail("output path too long");
  FILE *file = fopen(path, "wb");
  if (!file) fail("cannot create output");
  if (size > 0 && fwrite(data, 1, size, file) != size) fail("cannot write output");
  if (fclose(file) != 0) fail("cannot close output");
}

static const TSLanguage *language_named(const char *name) {
  if (strcmp(name, "javascript") == 0) return tree_sitter_javascript();
  if (strcmp(name, "rust") == 0) return tree_sitter_rust();
  if (strcmp(name, "python") == 0) return tree_sitter_python();
  fail("unsupported language");
  return NULL;
}

static uint32_t parse_u32(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long result = strtoul(value, &end, 10);
  if (errno != 0 || !end || *end != '\0' || result > UINT32_MAX) fail("invalid integer argument");
  return (uint32_t)result;
}

static TSPoint point_for_byte(const char *data, uint32_t byte) {
  TSPoint point = {0, 0};
  for (uint32_t i = 0; i < byte; i++) {
    if (data[i] == '\n') {
      point.row++;
      point.column = 0;
    } else {
      point.column++;
    }
  }
  return point;
}

static Buffer apply_edit(Buffer source, uint32_t start, uint32_t old_end, Buffer replacement) {
  if (start > old_end || old_end > source.length) fail("edit range outside input");
  uint64_t new_length = (uint64_t)source.length - (old_end - start) + replacement.length;
  if (new_length > UINT32_MAX) fail("edited input too large");
  char *data = malloc((size_t)new_length + 1);
  if (!data) fail("out of memory");
  memcpy(data, source.data, start);
  memcpy(data + start, replacement.data, replacement.length);
  memcpy(data + start + replacement.length, source.data + old_end, source.length - old_end);
  data[new_length] = '\0';
  return (Buffer){data, (uint32_t)new_length};
}

static TSInputEdit make_edit(Buffer source, Buffer edited, uint32_t start, uint32_t old_end, uint32_t replacement_length) {
  uint32_t new_end = start + replacement_length;
  return (TSInputEdit){
      .start_byte = start,
      .old_end_byte = old_end,
      .new_end_byte = new_end,
      .start_point = point_for_byte(source.data, start),
      .old_end_point = point_for_byte(source.data, old_end),
      .new_end_point = point_for_byte(edited.data, new_end),
  };
}

static TSTree *parse_checked(TSParser *parser, const char *data, uint32_t length) {
  TSTree *tree = ts_parser_parse_string(parser, NULL, data, length);
  if (!tree) fail("parser returned no tree");
  TSNode root = ts_tree_root_node(tree);
  if (ts_node_is_null(root) || ts_node_has_error(root)) fail("parser produced an error tree");
  return tree;
}

static TSTree *parse_incremental_checked(TSParser *parser, const TSTree *old_tree, const char *data, uint32_t length) {
  TSTree *tree = ts_parser_parse_string(parser, old_tree, data, length);
  if (!tree) fail("incremental parser returned no tree");
  TSNode root = ts_tree_root_node(tree);
  if (ts_node_is_null(root) || ts_node_has_error(root)) fail("incremental parser produced an error tree");
  return tree;
}

static void raw_read_full(int fd, unsigned char *data, size_t length) {
#if !defined(__linux__) || !defined(__aarch64__)
#error "trusted control channel is pinned to linux/arm64"
#endif
  while (length > 0) {
    register long syscall_number __asm__("x8") = 63; /* read */
    register long argument_0 __asm__("x0") = fd;
    register long argument_1 __asm__("x1") = (long)data;
    register long argument_2 __asm__("x2") = (long)length;
    __asm__ volatile(
        "svc 0"
        : "+r"(argument_0)
        : "r"(argument_1), "r"(argument_2), "r"(syscall_number)
        : "memory", "cc");
    if (argument_0 == -EINTR) continue;
    if (argument_0 <= 0) raw_exit(2);
    data += argument_0;
    length -= (size_t)argument_0;
  }
}

static uint64_t load_le64(const unsigned char *data) {
  uint64_t value = 0;
  for (int i = 0; i < 8; i++) value |= (uint64_t)data[i] << (8 * i);
  return value;
}

static void store_le64(unsigned char *data, uint64_t value) {
  for (int i = 0; i < 8; i++) data[i] = (unsigned char)(value >> (8 * i));
}

/*
 * Replay resistance: every warmup and timed repetition parses
 * identity-distinct content drawn from a deterministic schedule seeded by the
 * trusted evaluator (the same seed drives the candidate and the in-eval
 * reference binary). A tree cached during one iteration is therefore
 * structurally wrong for every other iteration, and each timed tree's full
 * pre-order (symbol, start_byte, end_byte) signature is folded into a digest
 * the evaluator compares against the trusted reference run.
 */
#define FULL_MUTATION_STRIDE 2048u
/* Wider incremental stride: 4-11 dispersed edit sites per iteration keeps the
 * timed operation incremental-parse-shaped while still making every
 * iteration's content identity distinct and digest-bound. */
#define INCREMENTAL_MUTATION_STRIDE 32768u
#define WARMUP_ITERATIONS 2u

/* The candidate-linked harness holds no clock: the trusted Python parent
 * times every measured parse. The parent passes two inherited pipe
 * descriptors as the final bench arguments -- a go descriptor carrying the
 * parent's per-iteration opaque tokens (mutation seed, then parse-go token)
 * and a control descriptor carrying the harness's ready/prepped markers, the
 * post-parse parse-go echo that stops the parent's clock, and the per-phase
 * pre-order tree digest. */
/* Fixed warmup schedule seed, disjoint from every parent-delivered timed
 * token, so warmup content never recurs in a timed iteration. */
#define WARMUP_SEED UINT64_C(0x53A17C0FE2B9D680)

#define FULL_WARMUP_SALT UINT64_C(0x9A3D6B1F0C55E101)
#define FULL_TIMED_SALT UINT64_C(0x2C7E19D4B8A0F202)
#define INCREMENTAL_WARMUP_SALT UINT64_C(0x6F1B84C2D93A5303)
#define INCREMENTAL_TIMED_SALT UINT64_C(0xE45A0F7186C2D404)
#define DIGEST_BASIS UINT64_C(0xCBF29CE484222325)
/* The first 128 input bytes are never mutated: split-marker prefixes that
 * prefix-sensitive diagnostics (and their gating checks) depend on must stay
 * byte-stable across every schedule variant. */
#define MUTATION_PREFIX_EXCLUSION 128u

static uint64_t mix64(uint64_t value) {
  value ^= value >> 30;
  value *= UINT64_C(0xBF58476D1CE4E5B9);
  value ^= value >> 27;
  value *= UINT64_C(0x94D049BB133111EB);
  value ^= value >> 31;
  return value;
}

static uint64_t schedule_next(uint64_t *state) {
  *state += UINT64_C(0x9E3779B97F4A7C15);
  return mix64(*state);
}

static uint64_t fold_value(uint64_t digest, uint64_t value) {
  digest ^= value;
  digest *= UINT64_C(0x00000100000001B3);
  return digest;
}

typedef struct {
  uint32_t *positions;
  char *saved;
  uint32_t count;
} Mutation;

/*
 * Overwrite roughly one alphanumeric byte per stride-sized block with a
 * schedule-chosen different byte of the same character class (letter case and
 * digits preserved). Length is preserved, so the trusted byte counters are
 * unchanged, and string/bracket/operator bytes are never touched, so the
 * workload magnitude stays comparable to the pristine input while the content
 * identity of every repetition is distinct and dispersed across the whole
 * buffer. Swaps landing on keywords or literal prefixes still change
 * tokenization, which is what binds the timed tree digests to each variant.
 */
static Mutation mutate_buffer(Buffer buffer, uint32_t stride, uint64_t seed, uint64_t salt, uint32_t iteration) {
  uint32_t max_count = buffer.length / stride + 1;
  Mutation mutation = {malloc(max_count * sizeof(uint32_t)), malloc(max_count), 0};
  if (!mutation.positions || !mutation.saved) fail("out of memory");
  uint64_t state = mix64(seed ^ salt ^ (((uint64_t)iteration << 1) | 1));
  for (uint64_t block = 0; block * stride < buffer.length; block++) {
    uint64_t word = schedule_next(&state);
    uint64_t position64 = block * stride + (uint32_t)(word % stride);
    if (position64 < MUTATION_PREFIX_EXCLUSION || position64 >= buffer.length) continue;
    uint32_t position = (uint32_t)position64;
    char original = buffer.data[position];
    char class_base;
    uint32_t class_size;
    if (original >= 'a' && original <= 'z') {
      class_base = 'a';
      class_size = 26;
    } else if (original >= 'A' && original <= 'Z') {
      class_base = 'A';
      class_size = 26;
    } else if (original >= '0' && original <= '9') {
      class_base = '0';
      class_size = 10;
    } else {
      continue;
    }
    uint32_t shift = 1 + (uint32_t)((word >> 32) % (class_size - 1));
    char replacement = (char)(class_base + ((uint32_t)(original - class_base) + shift) % class_size);
    mutation.positions[mutation.count] = position;
    mutation.saved[mutation.count] = original;
    mutation.count++;
    buffer.data[position] = replacement;
  }
  return mutation;
}

static void revert_buffer(Buffer buffer, Mutation *mutation) {
  for (uint32_t i = 0; i < mutation->count; i++) {
    buffer.data[mutation->positions[i]] = mutation->saved[i];
  }
  free(mutation->positions);
  free(mutation->saved);
  mutation->positions = NULL;
  mutation->saved = NULL;
  mutation->count = 0;
}

typedef struct {
  uint32_t *starts;
  uint32_t count;
} LineIndex;

static LineIndex build_line_index(Buffer buffer) {
  uint32_t count = 1;
  for (uint32_t i = 0; i < buffer.length; i++) {
    if (buffer.data[i] == '\n') count++;
  }
  uint32_t *starts = malloc((size_t)count * sizeof(uint32_t));
  if (!starts) fail("out of memory");
  starts[0] = 0;
  uint32_t next = 1;
  for (uint32_t i = 0; i < buffer.length; i++) {
    if (buffer.data[i] == '\n') starts[next++] = i + 1;
  }
  return (LineIndex){starts, count};
}

/* Mutations never target newline bytes, so the line index stays valid for
 * every schedule variant of the buffer it was built from. */
static TSPoint indexed_point(const LineIndex *index, uint32_t byte) {
  uint32_t low = 0;
  uint32_t high = index->count - 1;
  while (low < high) {
    uint32_t mid = low + (high - low + 1) / 2;
    if (index->starts[mid] <= byte) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return (TSPoint){low, byte - index->starts[low]};
}

/* Copy the sealed-edit base tree and register every schedule mutation as a
 * length-preserving single-byte edit, so the timed incremental parse must do
 * real re-lex work at each dispersed mutation site. */
static TSTree *copy_edited_tree(const TSTree *old_tree, const Mutation *mutation, const LineIndex *lines) {
  TSTree *tree = ts_tree_copy(old_tree);
  if (!tree) fail("cannot copy incremental base tree");
  for (uint32_t i = 0; i < mutation->count; i++) {
    uint32_t position = mutation->positions[i];
    TSPoint start_point = indexed_point(lines, position);
    TSPoint end_point = {start_point.row, start_point.column + 1};
    TSInputEdit micro = {
        .start_byte = position,
        .old_end_byte = position + 1,
        .new_end_byte = position + 1,
        .start_point = start_point,
        .old_end_point = end_point,
        .new_end_point = end_point,
    };
    ts_tree_edit(tree, &micro);
  }
  return tree;
}

/* Fold the complete pre-order (symbol, start_byte, end_byte) walk of the tree
 * into the digest. Schedule variants may legitimately contain error nodes;
 * the walk covers them identically for candidate and reference. */
static uint64_t fold_tree_signature(uint64_t digest, TSTree *tree) {
  TSNode root = ts_tree_root_node(tree);
  if (ts_node_is_null(root)) fail("timed parse produced no root node");
  digest = fold_value(digest, ts_node_has_error(root) ? 3 : 5);
  TSTreeCursor cursor = ts_tree_cursor_new(root);
  bool descend = true;
  for (;;) {
    if (descend) {
      TSNode node = ts_tree_cursor_current_node(&cursor);
      digest = fold_value(digest, ts_node_symbol(node));
      digest = fold_value(digest, ts_node_start_byte(node));
      digest = fold_value(digest, ts_node_end_byte(node));
      if (ts_tree_cursor_goto_first_child(&cursor)) continue;
    }
    if (ts_tree_cursor_goto_next_sibling(&cursor)) {
      descend = true;
      continue;
    }
    if (!ts_tree_cursor_goto_parent(&cursor)) break;
    descend = false;
  }
  ts_tree_cursor_delete(&cursor);
  return digest;
}

static void verify(const char *language_name, Buffer source, uint32_t start, uint32_t old_end,
                   Buffer replacement, const char *output_directory) {
  Buffer edited = apply_edit(source, start, old_end, replacement);
  TSInputEdit edit = make_edit(source, edited, start, old_end, replacement.length);
  TSParser *parser = ts_parser_new();
  if (!parser || !ts_parser_set_language(parser, language_named(language_name))) fail("cannot configure parser");

  TSTree *original = parse_checked(parser, source.data, source.length);
  char *original_string = ts_node_string(ts_tree_root_node(original));
  if (!original_string) fail("cannot serialize original tree");

  ts_tree_edit(original, &edit);
  TSTree *incremental = parse_incremental_checked(parser, original, edited.data, edited.length);
  char *incremental_string = ts_node_string(ts_tree_root_node(incremental));
  if (!incremental_string) fail("cannot serialize incremental tree");

  TSTree *fresh = parse_checked(parser, edited.data, edited.length);
  char *fresh_string = ts_node_string(ts_tree_root_node(fresh));
  if (!fresh_string) fail("cannot serialize edited tree");
  if (strcmp(incremental_string, fresh_string) != 0) fail("incremental tree differs from fresh full parse");

  uint32_t range_count = 0;
  TSRange *ranges = ts_tree_get_changed_ranges(original, incremental, &range_count);
  if (range_count == 0 || !ranges) fail("incremental edit produced no changed ranges");
  size_t range_capacity = (size_t)range_count * 160 + 1;
  char *range_text = malloc(range_capacity);
  if (!range_text) fail("out of memory");
  size_t range_length = 0;
  for (uint32_t i = 0; i < range_count; i++) {
    int written = snprintf(
        range_text + range_length, range_capacity - range_length,
        "%u:%u:%u-%u:%u:%u\n",
        ranges[i].start_byte,
        ranges[i].start_point.row,
        ranges[i].start_point.column,
        ranges[i].end_byte,
        ranges[i].end_point.row,
        ranges[i].end_point.column);
    if (written < 0 || (size_t)written >= range_capacity - range_length) {
      fail("changed-range serialization overflow");
    }
    range_length += (size_t)written;
  }

  write_file(output_directory, "original.tree", original_string, strlen(original_string));
  write_file(output_directory, "incremental.tree", incremental_string, strlen(incremental_string));
  write_file(output_directory, "edited-full.tree", fresh_string, strlen(fresh_string));
  write_file(output_directory, "changed-ranges.txt", range_text, range_length);

  free(ranges);
  free(range_text);
  free(original_string);
  free(incremental_string);
  free(fresh_string);
  ts_tree_delete(original);
  ts_tree_delete(incremental);
  ts_tree_delete(fresh);
  ts_parser_delete(parser);
  free(edited.data);
  static const char verdict[] = "{\"ok\":true,\"parserTests\":true,\"incrementalEqualsFull\":true}\n";
  raw_write(1, verdict, sizeof verdict - 1);
}

static void benchmark(const char *language_name, Buffer source, uint32_t start, uint32_t old_end,
                      Buffer replacement, uint32_t full_iterations, uint32_t incremental_iterations,
                      int go_fd, int ctrl_fd) {
  if (full_iterations == 0 || incremental_iterations == 0) fail("benchmark iteration count must be positive");
  Buffer edited = apply_edit(source, start, old_end, replacement);
  TSInputEdit edit = make_edit(source, edited, start, old_end, replacement.length);
  TSParser *parser = ts_parser_new();
  if (!parser || !ts_parser_set_language(parser, language_named(language_name))) fail("cannot configure parser");

  TSTree *old_tree = parse_checked(parser, source.data, source.length);
  ts_tree_edit(old_tree, &edit);
  LineIndex edited_lines = build_line_index(edited);

  /* Warmup repetitions draw from a fixed schedule seed disjoint from every
   * parent-delivered timed token, so no warmup content identity ever recurs
   * in a timed iteration; warmup is never on the trusted parent's clock. */
  for (uint32_t i = 0; i < WARMUP_ITERATIONS; i++) {
    Mutation full_mutation = mutate_buffer(source, FULL_MUTATION_STRIDE, WARMUP_SEED, FULL_WARMUP_SALT, i);
    TSTree *full = ts_parser_parse_string(parser, NULL, source.data, source.length);
    if (!full) fail("warmup parser returned no tree");
    ts_tree_delete(full);
    revert_buffer(source, &full_mutation);

    Mutation incremental_mutation =
        mutate_buffer(edited, INCREMENTAL_MUTATION_STRIDE, WARMUP_SEED, INCREMENTAL_WARMUP_SALT, i);
    TSTree *base = copy_edited_tree(old_tree, &incremental_mutation, &edited_lines);
    TSTree *incremental = ts_parser_parse_string(parser, base, edited.data, edited.length);
    if (!incremental) fail("warmup incremental parser returned no tree");
    ts_tree_delete(incremental);
    ts_tree_delete(base);
    revert_buffer(edited, &incremental_mutation);
  }

  /*
   * The trusted Python parent owns the clock. Per timed iteration the parent
   * delivers two opaque tokens on the go descriptor: a mutation seed, then
   * (after the per-iteration prep work it must never time) a parse-go token.
   * The harness echoes the parse-go token on the control descriptor only after
   * the parse returns, so the measured window is exactly the parse of
   * schedule-distinct content and the candidate-linked runtime holds no clock
   * it could rewrite or accumulator it could zero. Mutation, base-tree
   * construction, digesting, and cleanup all stay outside the measured window.
   * Every timed tree's full pre-order signature is folded into a digest the
   * parent compares against the pristine in-eval reference run on the same
   * token stream.
   */
  unsigned char seed_bytes[8];
  unsigned char go_bytes[8];
  unsigned char digest_bytes[8];

  uint64_t full_digest = DIGEST_BASIS;
  for (uint32_t i = 0; i < full_iterations; i++) {
    raw_write(ctrl_fd, "R", 1);
    raw_read_full(go_fd, seed_bytes, 8);
    Mutation mutation = mutate_buffer(source, FULL_MUTATION_STRIDE, load_le64(seed_bytes), FULL_TIMED_SALT, i);
    raw_write(ctrl_fd, "P", 1);
    raw_read_full(go_fd, go_bytes, 8);
    TSTree *tree = ts_parser_parse_string(parser, NULL, source.data, source.length);
    raw_write(ctrl_fd, (const char *)go_bytes, 8);
    if (!tree) fail("timed parser returned no tree");
    full_digest = fold_value(full_digest, i);
    full_digest = fold_tree_signature(full_digest, tree);
    ts_tree_delete(tree);
    revert_buffer(source, &mutation);
  }
  store_le64(digest_bytes, full_digest);
  raw_write(ctrl_fd, (const char *)digest_bytes, 8);

  uint64_t incremental_digest = DIGEST_BASIS;
  for (uint32_t i = 0; i < incremental_iterations; i++) {
    raw_write(ctrl_fd, "R", 1);
    raw_read_full(go_fd, seed_bytes, 8);
    Mutation mutation = mutate_buffer(edited, INCREMENTAL_MUTATION_STRIDE, load_le64(seed_bytes), INCREMENTAL_TIMED_SALT, i);
    TSTree *base = copy_edited_tree(old_tree, &mutation, &edited_lines);
    raw_write(ctrl_fd, "P", 1);
    raw_read_full(go_fd, go_bytes, 8);
    TSTree *tree = ts_parser_parse_string(parser, base, edited.data, edited.length);
    raw_write(ctrl_fd, (const char *)go_bytes, 8);
    if (!tree) fail("timed incremental parser returned no tree");
    incremental_digest = fold_value(incremental_digest, i);
    incremental_digest = fold_tree_signature(incremental_digest, tree);
    ts_tree_delete(tree);
    ts_tree_delete(base);
    revert_buffer(edited, &mutation);
  }
  store_le64(digest_bytes, incremental_digest);
  raw_write(ctrl_fd, (const char *)digest_bytes, 8);

  free(edited_lines.starts);
  ts_tree_delete(old_tree);
  ts_parser_delete(parser);
  free(edited.data);
}

int main(int argc, char **argv) {
  if (argc != 8 && argc != 11) fail("invalid argument count");
  const char *action = argv[1];
  const char *language_name = argv[2];
  Buffer source = read_file(argv[3]);
  uint32_t start = parse_u32(argv[4]);
  uint32_t old_end = parse_u32(argv[5]);
  Buffer replacement = read_file(argv[6]);

  if (strcmp(action, "verify") == 0 && argc == 8) {
    verify(language_name, source, start, old_end, replacement, argv[7]);
  } else if (strcmp(action, "bench") == 0 && argc == 11) {
    benchmark(language_name, source, start, old_end, replacement, parse_u32(argv[7]), parse_u32(argv[8]),
              (int)parse_u32(argv[9]), (int)parse_u32(argv[10]));
  } else {
    fail("invalid action");
  }

  free(source.data);
  free(replacement.data);
  return 0;
}