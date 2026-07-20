<div align="center">
<h1>instrument-hooks</h1>

[![CI](https://github.com/CodSpeedHQ/instrument-hooks/actions/workflows/ci.yml/badge.svg)](https://github.com/CodSpeedHQ/instrument-hooks/actions/workflows/ci.yml)
[![Discord](https://img.shields.io/badge/chat%20on-discord-7289da.svg)](https://discord.com/invite/MxpaCfKSqF)

Zig library to control instrumentations via IPC.

</div>

## Requirements

- **Zig**: 0.14
- [**Just**](https://github.com/casey/just) (optional): To easily run the build, formatter or tests

## Adding CodSpeed support for a new language

To integrate CodSpeed with a new language or benchmarking framework, you need to build a **custom harness** on top of `instrument-hooks`. See the **[custom harness guide](./CUSTOM_HARNESS.md)** for a step-by-step walkthrough, including a copy-paste prompt for setting it up with an AI agent. A minimal C harness is available in [`example/`](./example/).

## Run tests

```
zig build test --summary all
```
or
```
just test
```
