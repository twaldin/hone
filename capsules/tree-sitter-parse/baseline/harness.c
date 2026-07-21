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

static uint64_t now_ns(void) {
#if !defined(__linux__) || !defined(__aarch64__)
#error "trusted timer is pinned to linux/arm64"
#endif
  struct timespec value;
  register long syscall_number __asm__("x8") = 113;
  register long argument_0 __asm__("x0") = CLOCK_MONOTONIC_RAW;
  register long argument_1 __asm__("x1") = (long)&value;
  __asm__ volatile(
      "svc 0"
      : "+r"(argument_0)
      : "r"(argument_1), "r"(syscall_number)
      : "memory", "cc");
  if (argument_0 != 0) fail("kernel clock_gettime failed");
  return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
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
                      Buffer replacement, uint32_t full_iterations, uint32_t incremental_iterations) {
  if (full_iterations == 0 || incremental_iterations == 0) fail("benchmark iteration count must be positive");
  Buffer edited = apply_edit(source, start, old_end, replacement);
  TSInputEdit edit = make_edit(source, edited, start, old_end, replacement.length);
  TSParser *parser = ts_parser_new();
  if (!parser || !ts_parser_set_language(parser, language_named(language_name))) fail("cannot configure parser");

  TSTree *old_tree = parse_checked(parser, source.data, source.length);
  ts_tree_edit(old_tree, &edit);
  for (uint32_t i = 0; i < 2; i++) {
    TSTree *full = parse_checked(parser, source.data, source.length);
    ts_tree_delete(full);
    TSTree *incremental = parse_incremental_checked(parser, old_tree, edited.data, edited.length);
    ts_tree_delete(incremental);
  }

  uint64_t full_started = now_ns();
  for (uint32_t i = 0; i < full_iterations; i++) {
    TSTree *tree = parse_checked(parser, source.data, source.length);
    ts_tree_delete(tree);
  }
  uint64_t full_ns = now_ns() - full_started;

  uint64_t incremental_started = now_ns();
  for (uint32_t i = 0; i < incremental_iterations; i++) {
    TSTree *tree = parse_incremental_checked(parser, old_tree, edited.data, edited.length);
    ts_tree_delete(tree);
  }
  uint64_t incremental_ns = now_ns() - incremental_started;

  if (full_ns == 0 || incremental_ns == 0) fail("benchmark clock resolution failure");
  /* Counters travel only through the non-interposable raw channel; the trusted
   * evaluator independently recomputes both byte counters from the sealed
   * workload and iteration counts and rejects any disagreement. */
  char line[192];
  size_t offset = 0;
  offset = append_text(line, offset, sizeof line, "{\"ok\":true,\"fullBytes\":");
  offset = append_u64(line, offset, sizeof line, (uint64_t)source.length * full_iterations);
  offset = append_text(line, offset, sizeof line, ",\"fullNs\":");
  offset = append_u64(line, offset, sizeof line, full_ns);
  offset = append_text(line, offset, sizeof line, ",\"incrementalBytes\":");
  offset = append_u64(line, offset, sizeof line, (uint64_t)edited.length * incremental_iterations);
  offset = append_text(line, offset, sizeof line, ",\"incrementalNs\":");
  offset = append_u64(line, offset, sizeof line, incremental_ns);
  offset = append_text(line, offset, sizeof line, "}\n");
  raw_write(1, line, offset);

  ts_tree_delete(old_tree);
  ts_parser_delete(parser);
  free(edited.data);
}

int main(int argc, char **argv) {
  if (argc != 8 && argc != 9) fail("invalid argument count");
  const char *action = argv[1];
  const char *language_name = argv[2];
  Buffer source = read_file(argv[3]);
  uint32_t start = parse_u32(argv[4]);
  uint32_t old_end = parse_u32(argv[5]);
  Buffer replacement = read_file(argv[6]);

  if (strcmp(action, "verify") == 0 && argc == 8) {
    verify(language_name, source, start, old_end, replacement, argv[7]);
  } else if (strcmp(action, "bench") == 0 && argc == 9) {
    benchmark(language_name, source, start, old_end, replacement, parse_u32(argv[7]), parse_u32(argv[8]));
  } else {
    fail("invalid action");
  }

  free(source.data);
  free(replacement.data);
  return 0;
}