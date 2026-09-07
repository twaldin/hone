#ifndef TREE_SITTER_ALLOC_H_
#define TREE_SITTER_ALLOC_H_

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

#if defined(TREE_SITTER_HIDE_SYMBOLS) || defined(_WIN32)
#define TS_PUBLIC
#else
#define TS_PUBLIC __attribute__((visibility("default")))
#endif

TS_PUBLIC extern void *(*ts_current_malloc)(size_t size);
TS_PUBLIC extern void *(*ts_current_calloc)(size_t count, size_t size);
TS_PUBLIC extern void *(*ts_current_realloc)(void *ptr, size_t size);
TS_PUBLIC extern void (*ts_current_free)(void *ptr);

// Static-build devirtualization: this capsule links the runtime and trusted
// harness into one static executable and never installs a custom allocator,
// so the allocation entry points bind directly to libc instead of going
// through the mutable ts_current_* function pointers on every call.
static inline void *ts_malloc_direct(size_t size) {
  void *result = malloc(size);
  if (size > 0 && !result) abort();
  return result;
}
static inline void *ts_calloc_direct(size_t count, size_t size) {
  void *result = calloc(count, size);
  if (count > 0 && !result) abort();
  return result;
}
static inline void *ts_realloc_direct(void *buffer, size_t size) {
  void *result = realloc(buffer, size);
  if (size > 0 && !result) abort();
  return result;
}
#ifndef ts_malloc
#define ts_malloc  ts_malloc_direct
#endif
#ifndef ts_calloc
#define ts_calloc  ts_calloc_direct
#endif
#ifndef ts_realloc
#define ts_realloc ts_realloc_direct
#endif
#ifndef ts_free
#define ts_free    free
#endif

#ifdef __cplusplus
}
#endif

#endif // TREE_SITTER_ALLOC_H_
