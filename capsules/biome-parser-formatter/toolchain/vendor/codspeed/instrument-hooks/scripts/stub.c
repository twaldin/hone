// Stub implementations - instrumentation not supported on Windows/macOS
#include <stdbool.h>
#include <stdint.h>

typedef struct InstrumentHooks {
  char reserved;
} InstrumentHooks;

InstrumentHooks* instrument_hooks_init() {
  static InstrumentHooks instance = {};
  return &instance;
}

void instrument_hooks_deinit(InstrumentHooks* hooks) {}

bool instrument_hooks_is_instrumented(InstrumentHooks* hooks) { return false; }

uint8_t instrument_hooks_start_benchmark(InstrumentHooks* hooks) { return 0; }

uint8_t instrument_hooks_stop_benchmark(InstrumentHooks* hooks) { return 0; }

uint8_t instrument_hooks_set_executed_benchmark(InstrumentHooks* hooks,
                                                uint32_t pid, const char* uri) {
  return 0;
}

// Deprecated: use instrument_hooks_set_executed_benchmark instead
uint8_t instrument_hooks_executed_benchmark(InstrumentHooks* hooks,
                                            uint32_t pid, const char* uri) {
  return 0;
}

uint8_t instrument_hooks_set_integration(InstrumentHooks* hooks,
                                         const char* name,
                                         const char* version) {
  return 0;
}

void instrument_hooks_set_feature(InstrumentHooks* hooks, uint64_t feature,
                                  bool enabled) {}

uint64_t instrument_hooks_current_timestamp() { return 0; }

uint8_t instrument_hooks_add_marker(InstrumentHooks* hooks, uint32_t pid,
                                    uint8_t marker_type, uint64_t timestamp) {
  return 0;
}
