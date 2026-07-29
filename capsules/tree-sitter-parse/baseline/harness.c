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
 * Replay resistance: the timed content of every measured repetition is
 * derived from the parse-go token the trusted evaluator delivers at
 * clock-start (the same token drives the candidate and the in-eval reference
 * binary). Mutation, parse, and digest all run after the token arrives, so no
 * tree -- and therefore no correct digest -- can be produced before the clock
 * is running. Each timed tree's content-inclusive signature -- the full
 * pre-order (symbol, start_byte, end_byte) walk plus, for every leaf node,
 * the parsed buffer's source bytes in that leaf's range -- is folded
 * together with the go-token into the per-iteration receipt that stops the
 * parent's clock, so the receipt cannot be produced without completing the
 * parse inside the timed window; the evaluator folds the receipt stream and
 * compares it against the trusted reference run.
 *
 * Two schedule components additionally guarantee that the signature can only
 * come from a genuine re-lex of the token-seeded content, never from cached
 * structure:
 *   1. Every timed iteration applies guaranteed token-boundary-ALTERING
 *      edits: schedule-selected `identifier` leaf head bytes are overwritten
 *      with schedule-chosen delimiter bytes. EVERY incremental-phase edit is
 *      one, and the full phase applies one to EVERY permuted block that
 *      contains an eligible site (nearly all of them), every iteration. A
 *      delimiter can never lex as the head of that identifier, so the parsed
 *      tree's (symbol, start_byte, end_byte) layout MUST change around every
 *      edited site; a candidate replaying pre-edit structure (for example
 *      returning a copy of the edited base tree without parsing, or
 *      reassembling per-block structure cached under a block-content key)
 *      or under-registering any edit as skippable folds stale boundaries and
 *      diverges from the trusted reference leg -- no schedule edit is
 *      lexically neutral, so there is nothing provably skippable, and no
 *      block's byte content (and hence parsed structure) recurs between
 *      iterations, so nothing content-addressed is reusable either.
 *   2. Every timed FULL iteration parses a schedule-driven permutation of
 *      the workload's top-level line-aligned blocks assembled into a
 *      scratch buffer (length-preserving; the token multiset and construct
 *      mix are unchanged, so the honest full-parse workload magnitude is
 *      identical up to the dispersed component-1 edits, which both legs
 *      apply identically). Because nearly every token's absolute offset
 *      changes each iteration, no privately cached tree of any earlier
 *      content -- pristine or evolving -- is reachable from the current
 *      content by a sparse edit script; and because component 1 lands a
 *      boundary-altering delimiter edit inside nearly every block AND two
 *      interior class-preserving swaps inside EVERY named content leaf
 *      (identifier/string/number/comment/..., length >= 2) every iteration,
 *      each top-level item's byte CONTENT is high-entropy per iteration
 *      (per item, the product over its named leaves of (25*(len-1))^2), so
 *      no item's bytes recur across the whole timed schedule. An evolving,
 *      current-bytes-keyed per-item memoizer that splices cached parses into
 *      a live parse (skipping only guard-passing items) finds ~zero reusable
 *      items -- the throwaway probe measured zero reusable items of >= 64
 *      bytes in the mutable region on all six workloads -- and any
 *      reassemble-from-content-cache or incremental-from-cache substitute
 *      for the full parse folds stale leaf bytes or boundaries and diverges
 *      from the trusted reference leg, degenerating to full-parse-shaped
 *      re-lex work. A named leaf's interior letter->letter / digit->digit
 *      swap keeps its token class, so the interior swaps never move a token
 *      boundary and add no error-recovery cost -- only content entropy.
 * Both components are derived from the same go-token schedule and applied
 * identically on the reference and candidate legs, so they are
 * observation-preserving for honest candidates.
 */
/* Full-phase schedule densities: roughly one class-preserving swap per
 * stride of buffer, one guaranteed boundary-altering delimiter substitution
 * per permuted block (with a stride-proportional top-up for blocks larger
 * than the stride), and two interior class-preserving swaps per named
 * content leaf, so every block's parsed structure AND every top-level item's
 * byte content are schedule-distinct every iteration. */
#define FULL_MUTATION_STRIDE 2048u
/* Wider incremental stride: 4-11 dispersed boundary-altering edit sites per
 * iteration keeps the timed operation incremental-parse-shaped while making
 * every iteration's content identity distinct and digest-bound. */
#define INCREMENTAL_MUTATION_STRIDE 32768u
#define WARMUP_ITERATIONS 2u

/* The candidate-linked harness holds no clock: the trusted Python parent
 * times every measured parse. The parent passes two inherited pipe
 * descriptors as the final bench arguments -- a go descriptor carrying the
 * parent's per-iteration parse-go token (delivered at clock-start), and a
 * control descriptor carrying the harness's ready marker and the per-iteration
 * receipt (a fold of the go-token and the completed parse's tree signature)
 * that stops the parent's clock. */
/* Fixed warmup schedule seed. Parent-delivered timed tokens are unpredictable
 * 64-bit CSPRNG draws revealed only at clock-start, so warmup content
 * coinciding with any timed iteration is a 2^-64 event, and no warmup work can
 * be steered toward a future timed iteration's content. */
#define WARMUP_SEED UINT64_C(0x53A17C0FE2B9D680)

#define FULL_WARMUP_SALT UINT64_C(0x9A3D6B1F0C55E101)
#define FULL_TIMED_SALT UINT64_C(0x2C7E19D4B8A0F202)
#define INCREMENTAL_WARMUP_SALT UINT64_C(0x6F1B84C2D93A5303)
#define INCREMENTAL_TIMED_SALT UINT64_C(0xE45A0F7186C2D404)
#define DIGEST_BASIS UINT64_C(0xCBF29CE484222325)
/* The first 128 input bytes are never mutated and never moved by the
 * full-phase block permutation: split-marker prefixes that prefix-sensitive
 * diagnostics (and their gating checks) depend on must stay byte-stable
 * across every schedule variant. */
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

/* Guaranteed token-boundary-altering replacement bytes: single-character
 * delimiter tokens in all three pinned grammars, never alphanumeric, never
 * an identifier character, and never a newline (the incremental-phase line
 * index stays valid). */
static const char BOUNDARY_SPLITTERS[] = ";,()";
#define BOUNDARY_SPLITTER_COUNT (sizeof BOUNDARY_SPLITTERS - 1)

/* Pool of guaranteed token-boundary-altering edit sites: the first byte of
 * every named `identifier` leaf of at least two bytes at or past
 * minimum_start. Overwriting that byte with a delimiter cannot lex as the
 * same identifier token, so the covering leaf's boundaries -- and therefore
 * the content-inclusive tree signature -- must change. The pool is computed
 * once, untimed, from the setup parse whose exact tree the verify gate pins,
 * so reference and candidate legs derive identical pools. */
typedef struct {
  uint32_t *sites;   /* identifier leaf head byte (boundary-edit site) */
  uint32_t *lengths; /* identifier leaf byte length (>= 2 by construction) */
  uint32_t count;
} SitePool;

static bool leaf_is_identifier(TSNode node, const TSLanguage *language) {
  if (!ts_node_is_named(node)) return false;
  if (ts_node_end_byte(node) - ts_node_start_byte(node) < 2) return false;
  const char *name = ts_language_symbol_name(language, ts_node_symbol(node));
  return name != NULL && strcmp(name, "identifier") == 0;
}

static SitePool build_site_pool(TSTree *tree, uint32_t minimum_start) {
  const TSLanguage *language = ts_tree_language(tree);
  SitePool pool = {NULL, NULL, 0};
  uint32_t capacity = 0;
  TSNode root = ts_tree_root_node(tree);
  if (ts_node_is_null(root)) fail("setup parse produced no root node");
  TSTreeCursor cursor = ts_tree_cursor_new(root);
  bool descend = true;
  for (;;) {
    if (descend) {
      TSNode node = ts_tree_cursor_current_node(&cursor);
      if (ts_tree_cursor_goto_first_child(&cursor)) continue;
      uint32_t start = ts_node_start_byte(node);
      if (start >= minimum_start && leaf_is_identifier(node, language)) {
        if (pool.count == capacity) {
          capacity = capacity == 0 ? 1024 : capacity * 2;
          uint32_t *grown_sites = realloc(pool.sites, (size_t)capacity * sizeof(uint32_t));
          uint32_t *grown_lengths = realloc(pool.lengths, (size_t)capacity * sizeof(uint32_t));
          if (!grown_sites || !grown_lengths) fail("out of memory");
          pool.sites = grown_sites;
          pool.lengths = grown_lengths;
        }
        pool.lengths[pool.count] = ts_node_end_byte(node) - start;
        pool.sites[pool.count] = start;
        pool.count++;
      }
    }
    if (ts_tree_cursor_goto_next_sibling(&cursor)) {
      descend = true;
      continue;
    }
    if (!ts_tree_cursor_goto_parent(&cursor)) break;
    descend = false;
  }
  ts_tree_cursor_delete(&cursor);
  if (pool.count == 0) fail("no token-boundary edit sites in workload");
  return pool;
}

/* Full-phase permutation blocks: contiguous line-aligned ranges cut at the
 * start bytes of top-level tree nodes (root children), so every block is a
 * whole top-level item (or a small run of items) and any block order parses
 * as the same construct mix with the same token multiset. The cut list keeps
 * every eligible top-level item start (capped only for memory sanity), so
 * blocks are item-granular: between any two schedule permutations the
 * expected fraction of blocks preserved in relative order (the longest
 * increasing subsequence, ~2*sqrt(B) of B blocks) is a few percent, which
 * caps how much of ANY privately cached tree an incremental-from-cache
 * substitute for the full parse could ever reuse; and because the full
 * phase additionally lands a structure-altering boundary edit inside
 * nearly every block every iteration, a per-block subtree cache keyed by
 * block content misses on nearly every block as well. The prefix before
 * the first cut is never moved. */
#define PERMUTATION_MAX_BLOCKS 4096u
#define PERMUTATION_MIN_BLOCKS 16u

typedef struct {
  uint32_t *starts;          /* count + 1 boundaries in pristine coordinates */
  uint32_t *order;           /* per-iteration permutation scratch */
  uint32_t *permuted_starts; /* per-iteration landing offset of each block */
  uint32_t count;
} BlockIndex;

static BlockIndex build_block_index(TSTree *tree, Buffer source) {
  TSNode root = ts_tree_root_node(tree);
  if (ts_node_is_null(root)) fail("setup parse produced no root node");
  uint32_t *candidates = NULL;
  uint32_t candidate_count = 0;
  uint32_t capacity = 0;
  TSTreeCursor cursor = ts_tree_cursor_new(root);
  if (ts_tree_cursor_goto_first_child(&cursor)) {
    do {
      TSNode child = ts_tree_cursor_current_node(&cursor);
      uint32_t start = ts_node_start_byte(child);
      if (start >= MUTATION_PREFIX_EXCLUSION && start < source.length &&
          source.data[start - 1] == '\n' &&
          (candidate_count == 0 || candidates[candidate_count - 1] != start)) {
        if (candidate_count == capacity) {
          capacity = capacity == 0 ? 1024 : capacity * 2;
          uint32_t *grown = realloc(candidates, (size_t)capacity * sizeof(uint32_t));
          if (!grown) fail("out of memory");
          candidates = grown;
        }
        candidates[candidate_count++] = start;
      }
    } while (ts_tree_cursor_goto_next_sibling(&cursor));
  }
  ts_tree_cursor_delete(&cursor);
  if (candidate_count < PERMUTATION_MIN_BLOCKS) fail("too few top-level blocks to permute");
  BlockIndex index;
  index.count = candidate_count < PERMUTATION_MAX_BLOCKS ? candidate_count : PERMUTATION_MAX_BLOCKS;
  index.starts = malloc(((size_t)index.count + 1) * sizeof(uint32_t));
  index.order = malloc((size_t)index.count * sizeof(uint32_t));
  index.permuted_starts = malloc((size_t)index.count * sizeof(uint32_t));
  if (!index.starts || !index.order || !index.permuted_starts) fail("out of memory");
  for (uint32_t block = 0; block < index.count; block++) {
    index.starts[block] = candidates[(uint64_t)block * candidate_count / index.count];
  }
  index.starts[index.count] = source.length;
  free(candidates);
  return index;
}

/* Full-phase boundary-edit sites in block-relative coordinates, so a site
 * follows its block wherever the per-iteration permutation places it. The
 * entries are grouped per block (`first[b] .. first[b + 1]`) so the full
 * phase can land a schedule-chosen structure-altering edit inside EVERY
 * block that has an eligible site, every iteration. */
typedef struct {
  uint32_t *block;
  uint32_t *offset;
  uint32_t *first; /* blocks->count + 1 entry offsets, CSR-style */
  uint32_t count;
} BlockSitePool;

static BlockSitePool build_block_site_pool(const SitePool *pool, const BlockIndex *blocks) {
  BlockSitePool result = {
      malloc((size_t)pool->count * sizeof(uint32_t)),
      malloc((size_t)pool->count * sizeof(uint32_t)),
      malloc(((size_t)blocks->count + 1) * sizeof(uint32_t)),
      0,
  };
  if (!result.block || !result.offset || !result.first) fail("out of memory");
  for (uint32_t i = 0; i < pool->count; i++) {
    uint32_t site = pool->sites[i];
    if (site < blocks->starts[0]) continue;
    uint32_t low = 0;
    uint32_t high = blocks->count - 1;
    while (low < high) {
      uint32_t mid = low + (high - low + 1) / 2;
      if (blocks->starts[mid] <= site) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    if (result.count > 0 && low < result.block[result.count - 1]) {
      fail("edit-site pool is not block-sorted");
    }
    result.block[result.count] = low;
    result.offset[result.count] = site - blocks->starts[low];
    result.count++;
  }
  if (result.count == 0) fail("no token-boundary edit sites inside permutable blocks");
  /* Site pool entries arrive in ascending site order, so entries of one
   * block are contiguous; record each block's entry range. */
  uint32_t entry = 0;
  for (uint32_t block = 0; block <= blocks->count; block++) {
    while (entry < result.count && result.block[entry] < block) entry++;
    result.first[block] = entry;
  }
  return result;
}

/* Full-phase content-densification pool: every NAMED leaf of length >= 2
 * (identifier, property/type/field identifier, string, number, comment,
 * ...), in block-relative coordinates so it follows its block through the
 * permutation. Named leaves are content tokens, never keywords or operators
 * (those are anonymous), so a class-preserving swap at an INTERIOR byte
 * (offset >= 1) of a named leaf keeps its token class -- an identifier stays
 * an identifier, a number stays a number, a string/comment stays itself --
 * and therefore never moves a token boundary (no added error-recovery cost,
 * so the full-parse magnitude and A-A sigma are preserved). The earlier
 * identifier-only pool excluded property/type/field identifiers, strings,
 * and numbers, leaving many items with no swappable content; broadening to
 * all named leaves covers essentially every top-level item that carries any
 * content token, so no item's byte content recurs across the timed
 * schedule. Entries are grouped per block (first[b]..first[b+1], CSR-style)
 * and arrive in ascending order because leaves are visited left to right. */
typedef struct {
  uint32_t *block;
  uint32_t *offset; /* block-relative named-leaf head byte */
  uint32_t *length; /* named-leaf byte length (>= 2) */
  uint32_t count;
} ContentPool;

static bool leaf_is_named_content(TSNode node) {
  if (!ts_node_is_named(node)) return false;
  return ts_node_end_byte(node) - ts_node_start_byte(node) >= 2;
}

static ContentPool build_content_pool(TSTree *tree, const BlockIndex *blocks) {
  TSNode root = ts_tree_root_node(tree);
  if (ts_node_is_null(root)) fail("setup parse produced no root node");
  uint32_t capacity = 1024;
  ContentPool pool = {
      malloc((size_t)capacity * sizeof(uint32_t)),
      malloc((size_t)capacity * sizeof(uint32_t)),
      malloc((size_t)capacity * sizeof(uint32_t)),
      0,
  };
  if (!pool.block || !pool.offset || !pool.length) fail("out of memory");
  TSTreeCursor cursor = ts_tree_cursor_new(root);
  bool descend = true;
  for (;;) {
    if (descend) {
      TSNode node = ts_tree_cursor_current_node(&cursor);
      if (ts_tree_cursor_goto_first_child(&cursor)) continue;
      uint32_t start = ts_node_start_byte(node);
      if (start >= blocks->starts[0] && leaf_is_named_content(node)) {
        uint32_t end = ts_node_end_byte(node);
        uint32_t low = 0;
        uint32_t high = blocks->count - 1;
        while (low < high) {
          uint32_t mid = low + (high - low + 1) / 2;
          if (blocks->starts[mid] <= start) {
            low = mid;
          } else {
            high = mid - 1;
          }
        }
        uint32_t block_end = blocks->starts[low + 1];
        if (end > block_end) end = block_end;
        if (end - start >= 2) {
          if (pool.count == capacity) {
            capacity *= 2;
            uint32_t *gb = realloc(pool.block, (size_t)capacity * sizeof(uint32_t));
            uint32_t *go = realloc(pool.offset, (size_t)capacity * sizeof(uint32_t));
            uint32_t *gl = realloc(pool.length, (size_t)capacity * sizeof(uint32_t));
            if (!gb || !go || !gl) fail("out of memory");
            pool.block = gb;
            pool.offset = go;
            pool.length = gl;
          }
          pool.block[pool.count] = low;
          pool.offset[pool.count] = start - blocks->starts[low];
          pool.length[pool.count] = end - start;
          pool.count++;
        }
      }
    }
    if (ts_tree_cursor_goto_next_sibling(&cursor)) {
      descend = true;
      continue;
    }
    if (!ts_tree_cursor_goto_parent(&cursor)) break;
    descend = false;
  }
  ts_tree_cursor_delete(&cursor);
  if (pool.count == 0) fail("no named-leaf content sites for densification");
  return pool;
}

/* Fisher-Yates over the block order from the schedule stream, then assemble
 * the permuted content into the scratch buffer (fixed prefix first). Records
 * where each block landed so block-relative sites can be resolved. */
static void assemble_permuted(Buffer scratch, Buffer source, BlockIndex *blocks, uint64_t *state) {
  uint32_t *order = blocks->order;
  for (uint32_t i = 0; i < blocks->count; i++) order[i] = i;
  for (uint32_t i = blocks->count - 1; i > 0; i--) {
    uint32_t j = (uint32_t)(schedule_next(state) % ((uint64_t)i + 1));
    uint32_t swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  memcpy(scratch.data, source.data, blocks->starts[0]);
  uint32_t cursor = blocks->starts[0];
  for (uint32_t i = 0; i < blocks->count; i++) {
    uint32_t block = order[i];
    uint32_t length = blocks->starts[block + 1] - blocks->starts[block];
    memcpy(scratch.data + cursor, source.data + blocks->starts[block], length);
    blocks->permuted_starts[block] = cursor;
    cursor += length;
  }
  if (cursor != source.length) fail("permuted assembly length mismatch");
  scratch.data[cursor] = '\0';
}

/*
 * Class-preserving single-byte swap: map an alphanumeric byte to a
 * schedule-chosen DIFFERENT byte of the same character class (lowercase,
 * uppercase, or digit); any non-alphanumeric byte (including identifier
 * '_' bytes) is returned unchanged. The shift is drawn from the high 32
 * bits of `word` and is always in [1, class_size - 1], so an alphanumeric
 * byte always changes. Length, case class, and newline bytes are all
 * preserved, so the trusted byte counters and the incremental-phase line
 * index stay valid.
 */
static char class_swap_byte(char original, uint64_t word) {
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
    return original;
  }
  uint32_t shift = 1 + (uint32_t)((word >> 32) % (class_size - 1));
  return (char)(class_base + ((uint32_t)(original - class_base) + shift) % class_size);
}

/*
 * Overwrite roughly one alphanumeric byte per stride-sized block with a
 * schedule-chosen different byte of the same character class (letter case and
 * digits preserved). Length is preserved, so the trusted byte counters are
 * unchanged, and string/bracket/operator bytes are never touched, so the
 * workload magnitude stays comparable to the pristine input while the content
 * identity of every repetition is distinct and dispersed across the whole
 * buffer. When record is non-NULL every swap is appended for later revert.
 */
static void apply_class_swaps(Buffer buffer, uint32_t stride, uint64_t *state, Mutation *record) {
  for (uint64_t block = 0; block * stride < buffer.length; block++) {
    uint64_t word = schedule_next(state);
    uint64_t position64 = block * stride + (uint32_t)(word % stride);
    if (position64 < MUTATION_PREFIX_EXCLUSION || position64 >= buffer.length) continue;
    uint32_t position = (uint32_t)position64;
    char original = buffer.data[position];
    char replacement = class_swap_byte(original, word);
    if (replacement == original) continue;
    if (record != NULL) {
      record->positions[record->count] = position;
      record->saved[record->count] = original;
      record->count++;
    }
    buffer.data[position] = replacement;
  }
}

/* Incremental-phase (and its warmup) schedule: each dispersed edit is a
 * guaranteed token-boundary-altering delimiter substitution at a
 * schedule-selected identifier head from the fixed site pool (roughly one
 * per stride of buffer, matching the round-6/7 edit-site magnitude), PLUS a
 * schedule-chosen class-preserving swap at a schedule-chosen INTERIOR byte
 * (offset in [1, min(len - 1, 63)]) of that same identifier leaf -- always
 * within +/-64 bytes of the boundary edit. No schedule edit is lexically
 * neutral, so a candidate cannot prove any site skippable and under-register
 * edits on the copied base tree: skipping any site leaves stale
 * (symbol, start, end) layout around it and the receipt diverges from the
 * trusted reference leg, while registering a site forces genuine re-lex work
 * there. The interior swap refreshes the local re-lex context each
 * iteration, so no per-site re-lex patch cached under identical surrounding
 * bytes is reusable across iterations. Every edit (head and interior) is
 * recorded for revert and for registration as a TSInputEdit on the copied
 * base tree. */
static Mutation mutate_buffer(Buffer buffer, uint32_t stride, uint64_t seed, uint64_t salt,
                              uint32_t iteration, const SitePool *pool) {
  uint32_t edit_count = buffer.length / stride + 1;
  /* Up to two recorded positions per edit (head delimiter + interior swap). */
  Mutation mutation = {malloc((size_t)edit_count * 2 * sizeof(uint32_t)),
                       malloc((size_t)edit_count * 2), 0};
  if (!mutation.positions || !mutation.saved) fail("out of memory");
  uint64_t state = mix64(seed ^ salt ^ (((uint64_t)iteration << 1) | 1));
  for (uint32_t edit = 0; edit < edit_count; edit++) {
    uint64_t word = schedule_next(&state);
    uint32_t index = (uint32_t)(word % pool->count);
    uint32_t site = pool->sites[index];
    mutation.positions[mutation.count] = site;
    mutation.saved[mutation.count] = buffer.data[site];
    mutation.count++;
    buffer.data[site] = BOUNDARY_SPLITTERS[(word >> 32) % BOUNDARY_SPLITTER_COUNT];
    /* Interior class swap on the same leaf (offset >= 1, so never the
     * boundary byte just overwritten), capped to +/-64 bytes of the head. */
    uint32_t span = pool->lengths[index] - 1;
    if (span > 63) span = 63;
    uint64_t word2 = schedule_next(&state);
    uint32_t interior_site = site + 1 + (uint32_t)((word2 >> 20) % span);
    char original = buffer.data[interior_site];
    char replacement = class_swap_byte(original, word2);
    if (replacement != original) {
      mutation.positions[mutation.count] = interior_site;
      mutation.saved[mutation.count] = original;
      mutation.count++;
      buffer.data[interior_site] = replacement;
    }
  }
  return mutation;
}

/* Full-phase (and its warmup) schedule: permute the top-level blocks into
 * the scratch buffer, disperse class-preserving swaps across the permuted
 * content, land a schedule-chosen guaranteed token-boundary-altering
 * delimiter substitution inside EVERY permuted block that contains an
 * eligible identifier-head site (nearly every block; stride-proportional
 * top-up for blocks larger than FULL_MUTATION_STRIDE) -- this is the
 * structural / error-recovery component both legs pay -- and finally apply,
 * to EVERY named content leaf (identifier/string/number/comment/..., length
 * >= 2), two schedule-chosen class-preserving swaps at schedule-chosen
 * INTERIOR bytes (offset >= 1, never a token head/boundary), resolved
 * through the permutation. The interior swaps are the content-entropy
 * component: a named leaf's interior letter->letter / digit->digit swap
 * keeps its token class, so no token boundary moves (no added error-recovery
 * cost, so both legs' full-parse magnitude and the A-A sigma are preserved)
 * yet the covering leaf's content always changes. Because the pool spans
 * every named leaf (not just `identifier`), essentially every top-level item
 * that carries any content token is densified: each item's per-iteration
 * content space is the product over its named leaves of (25*(len-1))^2, so
 * no top-level item's byte content recurs across the whole timed schedule.
 * An evolving, current-bytes-keyed per-item memoizer that splices cached
 * parses into a live parse (skipping only guard-passing items) finds ~zero
 * reusable items, and any reassemble-from-content-cache substitute folds
 * stale leaf bytes and diverges from the trusted reference leg. Both legs
 * apply the identical schedule-derived edits, all length- and
 * newline-preserving, so the (error-recovery-inclusive) full-parse cost is
 * observation-preserving. The scratch buffer is rebuilt from the pristine
 * source every iteration, so no revert is needed. */
static void build_full_phase_content(Buffer scratch, Buffer source, BlockIndex *blocks,
                                     const BlockSitePool *pool, const ContentPool *content,
                                     uint64_t seed, uint64_t salt, uint32_t iteration) {
  uint64_t state = mix64(seed ^ salt ^ (((uint64_t)iteration << 1) | 1));
  assemble_permuted(scratch, source, blocks, &state);
  apply_class_swaps(scratch, FULL_MUTATION_STRIDE, &state, NULL);
  for (uint32_t block = 0; block < blocks->count; block++) {
    uint32_t begin = pool->first[block];
    uint32_t end = pool->first[block + 1];
    if (begin == end) continue;
    uint32_t block_length = blocks->starts[block + 1] - blocks->starts[block];
    uint32_t edits = 1 + block_length / FULL_MUTATION_STRIDE;
    for (uint32_t edit = 0; edit < edits; edit++) {
      uint64_t word = schedule_next(&state);
      uint32_t entry = begin + (uint32_t)(word % (end - begin));
      uint32_t site = blocks->permuted_starts[block] + pool->offset[entry];
      scratch.data[site] = BOUNDARY_SPLITTERS[(word >> 32) % BOUNDARY_SPLITTER_COUNT];
    }
  }
  /* Content-entropy component: two interior class-preserving swaps at every
   * named content leaf (structure-safe, so no token boundary moves). */
  for (uint32_t entry = 0; entry < content->count; entry++) {
    uint32_t base = blocks->permuted_starts[content->block[entry]] + content->offset[entry];
    uint32_t span = content->length[entry] - 1;
    for (uint32_t swap = 0; swap < 2; swap++) {
      uint64_t word = schedule_next(&state);
      uint32_t site = base + 1 + (uint32_t)((word >> 20) % span);
      scratch.data[site] = class_swap_byte(scratch.data[site], word);
    }
  }
}

static void revert_buffer(Buffer buffer, Mutation *mutation) {
  /* LIFO restore: the boundary-altering site may coincide with a class swap,
   * and reverse order returns overlapping positions to their original byte. */
  for (uint32_t i = mutation->count; i-- > 0;) {
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
 * AND, for every leaf node (a node with no visible children), a rolling FNV
 * of the parsed buffer's source bytes in [start_byte, end_byte) into the
 * digest. Structure alone is not enough: the mutation schedule is length- and
 * character-class-preserving, so a swap landing in the interior of an
 * identifier/number/string/comment token leaves every node boundary and
 * symbol unchanged; a structure-only signature would then be computable from
 * a cached pristine tree with no parse at all. Folding leaf content makes ANY
 * schedule mutation -- structure-changing or not -- alter the receipt, so a
 * genuine parse of the token-seeded content is forced inside every timed
 * window. Schedule variants may legitimately contain error nodes; the walk
 * covers them identically for candidate and reference, and BOTH legs run this
 * same trusted fold over their identical parsed buffers, so the content fold
 * is observation-preserving for honest candidates. */
static uint64_t fold_tree_signature(uint64_t digest, TSTree *tree, const char *source, uint32_t source_length) {
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
      /* Leaf: bind the digest to the token text itself, clamped to the
       * parsed buffer (clamping is identical on both legs). */
      uint32_t leaf_start = ts_node_start_byte(node);
      uint32_t leaf_end = ts_node_end_byte(node);
      if (leaf_start > source_length) leaf_start = source_length;
      if (leaf_end > source_length) leaf_end = source_length;
      uint64_t leaf_fold = DIGEST_BASIS;
      for (uint32_t byte = leaf_start; byte < leaf_end; byte++) {
        leaf_fold = fold_value(leaf_fold, (unsigned char)source[byte]);
      }
      digest = fold_value(digest, leaf_fold);
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
  /* Setup (untimed): the full-phase permutation blocks and both guaranteed
   * token-boundary edit-site pools derive from the setup parses whose exact
   * trees the verify gate pins, so reference and candidate legs compute
   * identical schedules. Source-coordinate structures are captured before
   * the sealed edit is registered on the base tree. */
  BlockIndex blocks = build_block_index(old_tree, source);
  SitePool source_sites = build_site_pool(old_tree, blocks.starts[0]);
  BlockSitePool full_sites = build_block_site_pool(&source_sites, &blocks);
  ContentPool content_pool = build_content_pool(old_tree, &blocks);
  ts_tree_edit(old_tree, &edit);
  LineIndex edited_lines = build_line_index(edited);
  TSTree *edited_tree = parse_checked(parser, edited.data, edited.length);
  SitePool incremental_sites = build_site_pool(edited_tree, MUTATION_PREFIX_EXCLUSION);
  ts_tree_delete(edited_tree);
  /* Full-phase scratch: rebuilt from the pristine source every iteration. */
  Buffer scratch = {malloc((size_t)source.length + 1), source.length};
  if (!scratch.data) fail("out of memory");

  /* Warmup repetitions draw from a fixed schedule seed disjoint from every
   * parent-delivered timed token, so no warmup content identity ever recurs
   * in a timed iteration; warmup is never on the trusted parent's clock. */
  for (uint32_t i = 0; i < WARMUP_ITERATIONS; i++) {
    build_full_phase_content(scratch, source, &blocks, &full_sites, &content_pool, WARMUP_SEED, FULL_WARMUP_SALT, i);
    TSTree *full = ts_parser_parse_string(parser, NULL, scratch.data, scratch.length);
    if (!full) fail("warmup parser returned no tree");
    ts_tree_delete(full);

    Mutation incremental_mutation =
        mutate_buffer(edited, INCREMENTAL_MUTATION_STRIDE, WARMUP_SEED, INCREMENTAL_WARMUP_SALT, i,
                      &incremental_sites);
    TSTree *base = copy_edited_tree(old_tree, &incremental_mutation, &edited_lines);
    TSTree *incremental = ts_parser_parse_string(parser, base, edited.data, edited.length);
    if (!incremental) fail("warmup incremental parser returned no tree");
    ts_tree_delete(incremental);
    ts_tree_delete(base);
    revert_buffer(edited, &incremental_mutation);
  }

  /*
   * The trusted Python parent owns the clock. Per timed iteration the parent
   * waits for the harness's ready marker, starts its clock, and releases a
   * single parse-go token on the go descriptor. The harness derives the whole
   * timed operation from that token: it seeds the per-iteration schedule with
   * the token (full phase: top-level block permutation + dispersed
   * class-preserving swaps + one guaranteed token-boundary-altering
   * delimiter substitution inside nearly every permuted block; incremental
   * phase: dispersed guaranteed boundary-altering substitutions), parses the
   * schedule-distinct content, folds the completed tree's content-inclusive
   * signature (its full pre-order walk plus every leaf's source bytes)
   * together with the token into a receipt, and only then writes that
   * receipt on the control descriptor to stop the parent's clock. Because
   * the mutation, parse, and digest all depend on a token that does not
   * exist until the clock is running, no correct receipt can be produced
   * before clock-start; because every iteration alters at least one token
   * boundary (and the full phase moves nearly every token's offset), the
   * receipt cannot be produced from any cached or replayed structure without
   * a genuine re-lex inside the measured window. The parent folds the
   * receipt stream and compares it against the pristine in-eval reference
   * run on the identical token stream.
   */
  unsigned char go_bytes[8];
  unsigned char receipt_bytes[8];

  for (uint32_t i = 0; i < full_iterations; i++) {
    raw_write(ctrl_fd, "R", 1);
    raw_read_full(go_fd, go_bytes, 8);
    uint64_t go = load_le64(go_bytes);
    build_full_phase_content(scratch, source, &blocks, &full_sites, &content_pool, go, FULL_TIMED_SALT, i);
    TSTree *tree = ts_parser_parse_string(parser, NULL, scratch.data, scratch.length);
    if (!tree) fail("timed parser returned no tree");
    uint64_t digest = fold_value(fold_value(DIGEST_BASIS, go), i);
    digest = fold_tree_signature(digest, tree, scratch.data, scratch.length);
    store_le64(receipt_bytes, mix64(digest ^ go));
    raw_write(ctrl_fd, (const char *)receipt_bytes, 8);
    ts_tree_delete(tree);
  }

  for (uint32_t i = 0; i < incremental_iterations; i++) {
    raw_write(ctrl_fd, "R", 1);
    raw_read_full(go_fd, go_bytes, 8);
    uint64_t go = load_le64(go_bytes);
    Mutation mutation =
        mutate_buffer(edited, INCREMENTAL_MUTATION_STRIDE, go, INCREMENTAL_TIMED_SALT, i, &incremental_sites);
    TSTree *base = copy_edited_tree(old_tree, &mutation, &edited_lines);
    TSTree *tree = ts_parser_parse_string(parser, base, edited.data, edited.length);
    if (!tree) fail("timed incremental parser returned no tree");
    uint64_t digest = fold_value(fold_value(DIGEST_BASIS, go), i);
    digest = fold_tree_signature(digest, tree, edited.data, edited.length);
    store_le64(receipt_bytes, mix64(digest ^ go));
    raw_write(ctrl_fd, (const char *)receipt_bytes, 8);
    ts_tree_delete(tree);
    ts_tree_delete(base);
    revert_buffer(edited, &mutation);
  }

  free(scratch.data);
  free(blocks.starts);
  free(blocks.order);
  free(blocks.permuted_starts);
  free(source_sites.sites);
  free(source_sites.lengths);
  free(incremental_sites.sites);
  free(incremental_sites.lengths);
  free(full_sites.block);
  free(full_sites.offset);
  free(full_sites.first);
  free(content_pool.block);
  free(content_pool.offset);
  free(content_pool.length);
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