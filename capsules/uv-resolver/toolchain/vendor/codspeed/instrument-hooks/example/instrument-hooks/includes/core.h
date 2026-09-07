// This file was manually created and exposes the functions of this library.
// TODO: Can we automatically generate this file?

#ifndef CORE_H
#define CORE_H

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef _WIN32
#include "callgrind.h"
#include "valgrind.h"
#else
#define CALLGRIND_START_INSTRUMENTATION
#define CALLGRIND_STOP_INSTRUMENTATION
#define CALLGRIND_ZERO_STATS
#endif

typedef struct InstrumentHooks InstrumentHooks;

InstrumentHooks *instrument_hooks_init(void);
void instrument_hooks_deinit(InstrumentHooks *);

bool instrument_hooks_is_instrumented(InstrumentHooks *);
uint8_t instrument_hooks_start_benchmark(InstrumentHooks *);
uint8_t instrument_hooks_stop_benchmark(InstrumentHooks *);
uint8_t instrument_hooks_set_executed_benchmark(InstrumentHooks *, int32_t pid,
                                                const char *uri);
// Deprecated: use instrument_hooks_set_executed_benchmark instead
uint8_t instrument_hooks_executed_benchmark(InstrumentHooks *, int32_t pid,
                                            const char *uri);
uint8_t instrument_hooks_set_integration(InstrumentHooks *, const char *name,
                                         const char *version);

#define MARKER_TYPE_SAMPLE_START 0
#define MARKER_TYPE_SAMPLE_END 1
#define MARKER_TYPE_BENCHMARK_START 2
#define MARKER_TYPE_BENCHMARK_END 3

uint8_t instrument_hooks_add_marker(InstrumentHooks *, int32_t pid,
                                    uint8_t marker_type, uint64_t timestamp);
uint64_t instrument_hooks_current_timestamp(void);

void callgrind_start_instrumentation();
void callgrind_stop_instrumentation();

// Feature flags for instrument hooks

typedef enum {
  FEATURE_DISABLE_CALLGRIND_MARKERS = 0,
} instrument_hooks_feature_t;

void instrument_hooks_set_feature(uint64_t feature, bool enabled);

// Environment collection
// Call set_environment to register key-value pairs grouped by section.
// Call collect_linked_libraries to gather linked library metadata.
// Then call write_environment to flush everything to
// $CODSPEED_PROFILE_FOLDER/environment-<pid>.json.
uint8_t instrument_hooks_set_environment(InstrumentHooks *,
                                         const char *section_name,
                                         const char *key, const char *value);
uint8_t instrument_hooks_set_environment_list(InstrumentHooks *,
                                              const char *section_name,
                                              const char *key,
                                              const char *const *values,
                                              uint32_t count);
uint8_t instrument_hooks_write_environment(InstrumentHooks *, int32_t pid);

// Header functions that will be inlined. This can be used by languages that
// directly consume the headers such as C or C++. This will allow for more
// precise tracking of the benchmark performance.

static inline uint8_t instrument_hooks_start_benchmark_inline(
    InstrumentHooks *instance) {
  instrument_hooks_set_feature(FEATURE_DISABLE_CALLGRIND_MARKERS, true);
  if (instrument_hooks_start_benchmark(instance) != 0) {
    return 1;
  }

  CALLGRIND_ZERO_STATS;
  CALLGRIND_START_INSTRUMENTATION;
  return 0;
}

static inline uint8_t instrument_hooks_stop_benchmark_inline(
    InstrumentHooks *instance) {
  CALLGRIND_STOP_INSTRUMENTATION;
  return instrument_hooks_stop_benchmark(instance);
}

#ifdef __cplusplus
}
#endif

#endif
