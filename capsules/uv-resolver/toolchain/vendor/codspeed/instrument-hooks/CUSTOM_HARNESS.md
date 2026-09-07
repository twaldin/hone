# Building a Custom Harness

This guide is for developers building a CodSpeed integration ("custom harness") for a new language or benchmarking framework. It explains how to use the `instrument-hooks` C library to connect your benchmarks to the CodSpeed runner.

A minimal working C harness lives in [`example/`](./example/) — refer to it alongside this guide.

For existing integrations you can reference as examples, see:
- [codspeed-rust](https://github.com/CodSpeedHQ/codspeed-rust) (Criterion, Divan)
- [codspeed-cpp](https://github.com/CodSpeedHQ/codspeed-cpp) (Google Benchmark)
- [codspeed-go](https://github.com/CodSpeedHQ/codspeed-go)

## Let Your Agent Build the Integration

Copy this block and paste it to your AI assistant to scaffold an instrument-hooks integration:

```text
I want to build a CodSpeed integration for [LANGUAGE/FRAMEWORK] using the instrument-hooks C library.

Repository: https://github.com/CodSpeedHQ/instrument-hooks
Read the full guide: CUSTOM_HARNESS.md in that repo.

Reference integrations to study:
- Rust: https://github.com/CodSpeedHQ/codspeed-rust
- C++: https://github.com/CodSpeedHQ/codspeed-cpp
- Go: https://github.com/CodSpeedHQ/codspeed-go

What instrument-hooks is:
- Single-file C library (dist/core.c + includes/) that bridges benchmark integrations with the CodSpeed runner via IPC
- Supports CPU Simulation (Callgrind) and Walltime (perf) measurement modes — auto-detected, the integration doesn't choose

What I need you to do:
1. Add instrument-hooks to my project as a git submodule (or fetch script for dist/ + includes/)
2. Set up the build to compile dist/core.c with warning suppression flags (see Build Notes in the guide)
3. Implement the benchmark lifecycle via FFI:
   a. instrument_hooks_init() → check for NULL
   b. instrument_hooks_is_instrumented() → gate CodSpeed-specific code paths
   c. instrument_hooks_set_integration(name, version) → register metadata
   d. instrument_hooks_start_benchmark() / instrument_hooks_stop_benchmark() → wrap benchmark execution
   e. instrument_hooks_set_executed_benchmark(pid, uri) → report what ran
   f. instrument_hooks_deinit() → clean up
4. Implement __codspeed_root_frame__:
   - The benchmarked code MUST execute inside a function whose name starts with __codspeed_root_frame__
   - This function MUST be marked noinline (__attribute__((noinline)), #[inline(never)], etc.)
   - This is required for flamegraphs to have a clean root
5. Construct benchmark URIs in the format: {git_relative_file_path}::{benchmark_name}[optional_params]
6. Test with: codspeed run --skip-upload -- <benchmark_command>

Critical rules:
- All functions return uint8_t where 0 = success. Always check return values.
- For CPU Simulation: start_benchmark/stop_benchmark must be as CLOSE as possible to the actual benchmark code (every instruction between them is counted)
- Benchmark markers (add_marker with BENCHMARK_START/END) are OPTIONAL and only relevant for Walltime flamegraph precision — skip them for a first implementation
- If using markers: every BENCHMARK_START must have a matching BENCHMARK_END, in chronological order

My setup:
- Language: [FILL IN]
- Benchmarking framework: [FILL IN]
- Build system: [FILL IN]
```

## Getting the Library

The library is distributed as a single C file (`dist/core.c`) plus headers (`includes/`).

**Preferred: Git submodule**

```bash
git submodule add https://github.com/CodSpeedHQ/instrument-hooks.git
```

Then reference `instrument-hooks/dist/core.c` and `instrument-hooks/includes/` in your build system.

**Alternative: Fetch script**

If your language's build system doesn't support submodules well, write a small script that downloads the `dist/` and `includes/` directories from a pinned release.

## Build Notes

The generated `dist/core.c` produces compiler warnings that are harmless. Suppress them in your build:

**GCC/Clang:**
```
-Wno-maybe-uninitialized -Wno-unused-variable -Wno-unused-parameter -Wno-unused-but-set-variable -Wno-type-limits
```

**MSVC:**
```
/wd4101 /wd4189 /wd4100 /wd4245 /wd4132 /wd4146
```

See the [example CMakeLists.txt](CMakeLists.txt) for a complete build configuration.

## Concepts

### CPU Simulation vs Walltime

CodSpeed supports two main measurement instruments. The choice is made by the user when configuring their CI — your integration doesn't need to detect or switch between them. However, understanding the difference matters for how you structure your integration code.

- **CPU Simulation**: Simulates CPU behavior to measure performance. Hardware-agnostic and deterministic. Best for small, CPU-bound workloads. See [CPU Simulation docs](https://codspeed.io/docs/instruments/cpu-simulation).
- **Walltime**: Measures real elapsed time on bare-metal runners with low noise. Supports flamegraphs and profiling. Best for I/O-heavy or longer-running benchmarks. See [Walltime docs](https://codspeed.io/docs/instruments/walltime).

Both instruments are supported through `instrument-hooks`. The main difference for integration authors is that **CPU Simulation requires `start_benchmark` / `stop_benchmark` to be as close as possible to the actual benchmark code** (see [Simulation Mode Notes](#simulation-mode-notes)).

### Benchmark Lifecycle

From your integration's perspective, the lifecycle is:

1. **Initialize** the library
2. **Check** if running under CodSpeed instrumentation
3. **Register** your integration's name and version
4. **For each benchmark:**
   - Start the benchmark measurement
   - Execute the benchmarked code (inside a [`__codspeed_root_frame__`](#codspeed-root-frame))
   - Stop the benchmark measurement
   - Report which benchmark was executed

4. **Clean up**

## Integration Walkthrough

### 1. Initialize

```c
InstrumentHooks *hooks = instrument_hooks_init();
if (!hooks) {
    // Initialization failed — handle error
    return 1;
}
```

### 2. Check if Instrumented

```c
if (instrument_hooks_is_instrumented(hooks)) {
    // Running under CodSpeed — enable measurement code paths
}
```

When `is_instrumented()` returns `false`, your integration should fall back to the framework's normal benchmarking behavior. When `true`, the CodSpeed runner is active and all `instrument-hooks` calls will communicate with it.

### 3. Register Your Integration

```c
instrument_hooks_set_integration(hooks, "my-framework-codspeed", "1.0.0");
```

This metadata helps CodSpeed identify which integration produced the results.

### 4. Run a Benchmark

```c
// Start measurement — tells the runner to begin recording
if (instrument_hooks_start_benchmark(hooks) != 0) {
    // handle error
}

// Execute the benchmark inside __codspeed_root_frame__ (see below)
run_benchmark();

// Stop measurement — tells the runner to stop recording
if (instrument_hooks_stop_benchmark(hooks) != 0) {
    // handle error
}
```

### 5. Report the Benchmark

```c
instrument_hooks_set_executed_benchmark(hooks, getpid(), "path/to/bench.rs::bench_name");
```

See [URI Convention](#uri-convention) for the expected format.

### 6. Clean Up

```c
instrument_hooks_deinit(hooks);
```

### CodSpeed Root Frame

For flamegraphs to work correctly, the actual benchmark code must execute inside a function named with the `__codspeed_root_frame__` prefix. This function acts as the root of the flamegraph — everything inside it is attributed to the benchmark, everything outside is filtered out.

**Requirements:**
- The function name must start with `__codspeed_root_frame__`
- It must **not** be inlined (use `__attribute__((noinline))`, `#[inline(never)]`, or equivalent)
- It must wrap the actual benchmark execution (the code being measured)

**C/C++ example:**

```c
__attribute__((noinline))
void __codspeed_root_frame__run(void (*benchmark_fn)(void)) {
    benchmark_fn();
}
```

**Rust example** (from the Criterion integration):

```rust
#[inline(never)]
pub fn __codspeed_root_frame__iter<O, R>(&mut self, mut routine: R)
where
    R: FnMut() -> O,
{
    let bench_start = InstrumentHooks::current_timestamp();
    for _ in 0..self.iters {
        black_box(routine());
    }
    let bench_end = InstrumentHooks::current_timestamp();
    InstrumentHooks::instance().add_benchmark_timestamps(bench_start, bench_end);
}

// Public API delegates to the root frame function:
#[inline(never)]
pub fn iter<O, R>(&mut self, routine: R) {
    self.__codspeed_root_frame__iter(routine)
}
```

The pattern is: your public API method delegates to a `__codspeed_root_frame__`-prefixed implementation that contains all the measurement logic.

## URI Convention

The benchmark URI passed to `set_executed_benchmark` should follow this format:

```
{git_relative_file_path}::{benchmark_name_components}
```

- **`git_relative_file_path`**: Path to the benchmark file, relative to the git repository root
- **`benchmark_name_components`**: Benchmark identifiers separated by `::`, optionally with parameters in `[]`

**Examples:**

```
benches/my_bench.rs::group_name::bench_function
benches/my_bench.rs::group_name::bench_function[parameter_value]
bench_test.go::BenchmarkSort::BySize[100]
```

For reference, see how existing integrations construct URIs:
- **Rust/Criterion**: `{file}::{macro_group}::{bench_id}[::function][params]`
- **Rust/Divan**: `{file}::{module_path}::{bench_name}[type, arg]`
- **Go**: `{file}::{sub_bench_components}`

## Precise Flamegraphs (Optional)

By default, the flamegraph shows everything that happened between `start_benchmark()` and `stop_benchmark()`. This is often good enough.

For more precise flamegraphs, you can add **benchmark markers** that mark exactly when the benchmarked code was running, excluding setup and teardown code within the measurement window.

This is **only relevant for walltime** — CPU Simulation does not use markers for flamegraphs.

### How It Works

1. Capture a timestamp **before** the benchmarked code runs
2. Execute the benchmark
3. Capture a timestamp **after** the benchmarked code runs
4. Send both timestamps as `BENCHMARK_START` and `BENCHMARK_END` markers

```c
uint32_t pid = getpid();

// Inside the measurement window (between start_benchmark/stop_benchmark):
for (int i = 0; i < iterations; i++) {
    expensive_setup();  // This will be EXCLUDED from the flamegraph

    uint64_t start_time = instrument_hooks_current_timestamp();
    benchmark_function();  // This will be INCLUDED in the flamegraph
    uint64_t end_time = instrument_hooks_current_timestamp();

    instrument_hooks_add_marker(hooks, pid, MARKER_TYPE_BENCHMARK_START, start_time);
    instrument_hooks_add_marker(hooks, pid, MARKER_TYPE_BENCHMARK_END, end_time);
}
```

You can add multiple pairs of `BENCHMARK_START` / `BENCHMARK_END` markers within a single benchmark — for example, one pair per iteration.

### Marker Ordering Rules

Markers must follow this strict ordering:

```
start_benchmark()
  └─ BENCHMARK_START(t1)
  └─ BENCHMARK_END(t2)       // t2 > t1
  └─ BENCHMARK_START(t3)     // t3 > t2 (optional, more iterations)
  └─ BENCHMARK_END(t4)       // t4 > t3
  └─ ...
stop_benchmark()
```

- Every `BENCHMARK_START` must have a matching `BENCHMARK_END`
- Markers must be in chronological order
- Markers are optional — if you don't add any, the entire `start_benchmark` / `stop_benchmark` window is used

## Simulation Mode Notes

In CPU Simulation mode, the measurement works differently from walltime. The key thing to know:

**`start_benchmark()` and `stop_benchmark()` must be as close as possible to the actual benchmark code.** In simulation mode, the simulator counts every instruction between start and stop — any framework overhead (setup, teardown, bookkeeping) will be included in the measurement and distort the results.

For reference on how existing integrations handle this:
- **Rust/Criterion**: [`crates/criterion_compat/criterion_fork/src/routine.rs`](https://github.com/CodSpeedHQ/codspeed-rust/blob/main/crates/criterion_compat/criterion_fork/src/routine.rs) — `start_benchmark()` and `stop_benchmark()` wrap only the benchmark execution
- **C++/Google Benchmark**: [`google_benchmark/src/benchmark_runner.cc`](https://github.com/CodSpeedHQ/codspeed-cpp/blob/main/google_benchmark/src/benchmark_runner.cc)

Markers (`add_marker`) are **not needed** for simulation mode.

## Testing Your Integration

### Basic Verification

Run your integration with CodSpeed using the `--skip-upload` flag to test locally without sending data:

```bash
codspeed run --skip-upload -- <your_benchmark_command>
```

Check that:
- `is_instrumented()` returns `true`
- Benchmarks execute without errors
- The output shows your benchmarks being detected

### Full Test

Once the basic flow works, try without `--skip-upload`:

```bash
codspeed run -- <your_benchmark_command>
```

This will attempt to upload results to CodSpeed, verifying the full pipeline.

### Getting Help

If you run into issues, reach out on [Discord](https://discord.com/invite/MxpaCfKSqF) or by email.

## Common Pitfalls

### Marker Ordering Violations

The backend strictly validates marker ordering. Every `BENCHMARK_START` must be followed by a `BENCHMARK_END` before the next `BENCHMARK_START`. Unclosed or out-of-order markers will cause errors.

### Simulation: Start/Stop Distance

In CPU Simulation mode, every instruction between `start_benchmark()` and `stop_benchmark()` is counted. If your framework does bookkeeping, memory allocation, or logging between these calls, it will show up in the measurement. Keep the window tight around the actual benchmark code.

### Function Return Values

All `instrument_hooks_*` functions return `uint8_t` where `0` means success. Always check return values — a non-zero return indicates communication with the runner failed.

### Root Frame Optimization

If `__codspeed_root_frame__` gets inlined by the compiler, flamegraphs won't have a clean root. Always mark it as `noinline`. In C/C++, use `__attribute__((noinline))`. In Rust, use `#[inline(never)]`.
