// Stub implementations - instrumentation not supported on Windows
#include <stdlib.h>

#include "core.h"

struct InstrumentHooks {
  uint64_t _unused;
};

static struct InstrumentHooks stub_instance = {0};

InstrumentHooks *instrument_hooks_init(void) { return &stub_instance; }

void instrument_hooks_deinit(InstrumentHooks *hooks) { (void)hooks; }

bool instrument_hooks_is_instrumented(InstrumentHooks *hooks) {
  (void)hooks;
  return false;
}

uint8_t instrument_hooks_start_benchmark(InstrumentHooks *hooks) {
  (void)hooks;
  return 0;
}

uint8_t instrument_hooks_stop_benchmark(InstrumentHooks *hooks) {
  (void)hooks;
  return 0;
}

uint8_t instrument_hooks_set_executed_benchmark(InstrumentHooks *hooks,
                                                int32_t pid, const char *uri) {
  (void)hooks;
  (void)pid;
  (void)uri;
  return 0;
}

// Deprecated: use instrument_hooks_set_executed_benchmark instead
uint8_t instrument_hooks_executed_benchmark(InstrumentHooks *hooks, int32_t pid,
                                            const char *uri) {
  (void)hooks;
  (void)pid;
  (void)uri;
  return 0;
}

uint8_t instrument_hooks_set_integration(InstrumentHooks *hooks,
                                         const char *name,
                                         const char *version) {
  (void)hooks;
  (void)name;
  (void)version;
  return 0;
}

void instrument_hooks_set_feature(uint64_t feature, bool enabled) {
  (void)feature;
  (void)enabled;
}

uint64_t instrument_hooks_current_timestamp(void) { return 0; }

uint8_t instrument_hooks_add_marker(InstrumentHooks *hooks, int32_t pid,
                                    uint8_t marker_type, uint64_t timestamp) {
  (void)hooks;
  (void)pid;
  (void)marker_type;
  (void)timestamp;
  return 0;
}

uint8_t instrument_hooks_set_environment(InstrumentHooks *hooks,
                                         const char *section_name,
                                         const char *key, const char *value) {
  (void)hooks;
  (void)section_name;
  (void)key;
  (void)value;
  return 0;
}

uint8_t instrument_hooks_set_environment_list(InstrumentHooks *hooks,
                                              const char *section_name,
                                              const char *key,
                                              const char *const *values,
                                              uint32_t count) {
  (void)hooks;
  (void)section_name;
  (void)key;
  (void)values;
  (void)count;
  return 0;
}

uint8_t instrument_hooks_write_environment(InstrumentHooks *hooks,
                                           int32_t pid) {
  (void)hooks;
  (void)pid;
  return 0;
}
