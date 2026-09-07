#include <stdio.h>
#ifdef _WIN32
#include <process.h>
#define getpid _getpid
#else
#include <unistd.h>
#endif

#include "core.h"

#if defined(_MSC_VER)
#define CODSPEED_NOINLINE __declspec(noinline)
#else
#define CODSPEED_NOINLINE __attribute__((noinline))
#endif

static int fib(int n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

static void expensive_setup(void) { fib(30); }

void example_function(void) {
  // Simulate some work
  for (volatile int i = 0; i < 100000; i++)
    ;
  printf("Benchmark executed\n");
}

CODSPEED_NOINLINE void __codspeed_root_frame__example(
    void (*benchmark_fn)(void)) {
  benchmark_fn();
}

int main() {
  InstrumentHooks *hooks = instrument_hooks_init();
  if (!hooks) {
    printf("Failed to initialize instrument hooks\n");
    return 1;
  }

  if (instrument_hooks_is_instrumented(hooks)) {
    printf("Running under instrumentation\n");
  } else {
    printf("Not running under instrumentation\n");
  }

  instrument_hooks_set_integration(hooks, "custom-integration", "1.0.0");

  printf("Starting benchmark...\n");
  if (instrument_hooks_start_benchmark_inline(hooks) != 0) {
    printf("Failed to start benchmark\n");
    instrument_hooks_deinit(hooks);
    return 1;
  }

  uint32_t pid = getpid();
  for (int i = 0; i < 10; i++) {
    // This won't be displayed in the flamegraph, because it's outside
    // the benchmark marker regions.
    expensive_setup();

    uint64_t start_time = instrument_hooks_current_timestamp();
    __codspeed_root_frame__example(example_function);
    uint64_t end_time = instrument_hooks_current_timestamp();

    // Add the markers which mark when the benchmarked function was running
    instrument_hooks_add_marker(hooks, pid, MARKER_TYPE_BENCHMARK_START,
                                start_time);
    instrument_hooks_add_marker(hooks, pid, MARKER_TYPE_BENCHMARK_END,
                                end_time);
  }

  if (instrument_hooks_stop_benchmark_inline(hooks) != 0) {
    printf("Failed to stop benchmark\n");
    instrument_hooks_deinit(hooks);
    return 1;
  }

  if (instrument_hooks_set_executed_benchmark(hooks, pid,
                                              "example_benchmark") != 0) {
    printf("Failed to report benchmark execution\n");
    instrument_hooks_deinit(hooks);
    return 1;
  }

  printf("Benchmark completed successfully\n");

  instrument_hooks_deinit(hooks);

  return 0;
}
