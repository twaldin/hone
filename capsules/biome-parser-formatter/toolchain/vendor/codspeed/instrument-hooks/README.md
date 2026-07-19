<div align="center">
<h1>instrument-hooks</h1>

[![CI](https://github.com/CodSpeedHQ/instrument-hooks/actions/workflows/ci.yml/badge.svg)](https://github.com/CodSpeedHQ/instrument-hooks/actions/workflows/ci.yml)
[![Discord](https://img.shields.io/badge/chat%20on-discord-7289da.svg)](https://discord.com/invite/MxpaCfKSqF)

Zig library to control instrumentations via IPC.

</div>

## Requirements

- **Zig**: 0.14
- [**Just**](https://github.com/casey/just) (optional): To easily run the build, formatter or tests

## How to add new integration?

This library is intended to be used as a C library. The main source file is in `dist/core.c` and the headers are in `includes/`. See `examples/main.c` for an example on how to use it.

To test if it worked, call `is_instrumented` which should return `false` when running without Codspeed. To run with Codspeed, execute the following:
```
codspeed run -- <your_cmd>
```

To make sure your integration is fully working, you have to implement all these hooks:
- start_benchmark: Call this when the benchmark starts, to start measuring the performance.
- stop_benchmark: Stop measuring the performance after the benchmark stopped.
- set_executed_benchmark: Provide metadata about which benchmark was executed.
- set_integration: Provide metadata about the integration.

## Run tests

```
zig build test --summary all
```
or
```
just test
```
