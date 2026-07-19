#ifndef WRAPPER_H
#define WRAPPER_H

#include <stdint.h>

#ifndef _WIN32
#include "callgrind.h"
#include "valgrind.h"

uint8_t running_on_valgrind() { return RUNNING_ON_VALGRIND > 0; }

void callgrind_dump_stats() { CALLGRIND_DUMP_STATS; }

void callgrind_dump_stats_at(uint8_t const* pos_str) {
  CALLGRIND_DUMP_STATS_AT(pos_str);
}

void callgrind_zero_stats() { CALLGRIND_ZERO_STATS; }

void callgrind_start_instrumentation() { CALLGRIND_START_INSTRUMENTATION; }

void callgrind_stop_instrumentation() { CALLGRIND_STOP_INSTRUMENTATION; }

#else
// Windows and other platforms - provide no-op implementations
uint8_t running_on_valgrind() { return 0; }

void callgrind_dump_stats() {}

void callgrind_dump_stats_at(uint8_t const* pos_str) {}

void callgrind_zero_stats() {}

void callgrind_start_instrumentation() {}

void callgrind_stop_instrumentation() {}
#endif

#endif
