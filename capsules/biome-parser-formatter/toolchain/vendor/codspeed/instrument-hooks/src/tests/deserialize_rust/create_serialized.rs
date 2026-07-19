#!/usr/bin/env rust-script

//! Serializes the shared `Command` enum to test whether Zig deserializes it correctly.
//!
//! # Run
//!
//! ```bash
//! ./create_serialized.rs > serialized.zig
//! ```
//!
//! ```cargo
//! [dependencies]
//! bincode = "1.3.3"
//! serde = { version = "1.0.192", features = ["derive"] }
//! runner-shared = { git = "https://github.com/CodSpeedHQ/runner" }
//! ```

// Import from runner-shared to ensure we use the same types
use runner_shared::fifo::{Command, MarkerType, RunnerMode};

fn dump(name: &str, result: &Vec<u8>) {
    print!("pub const {}: []const u8 = &.{{ ", name);
    for byte in result.iter() {
        print!("0x{:X}, ", byte);
    }
    println!(" }};");
}

fn example<T: serde::Serialize>(name: &str, value: &T) {
    let result = bincode::serialize(&value).unwrap();
    dump(name, &result);
}

fn main() {
    println!("// This file is generated using 'cargo run > rust_ser.zig'");
    println!("");

    example(
        "cmd_cur_bench",
        &Command::CurrentBenchmark {
            pid: 12345,
            uri: "http://example.com/benchmark".to_string(),
        },
    );
    example("cmd_start_bench", &Command::StartBenchmark);
    example("cmd_stop_bench", &Command::StopBenchmark);
    example("cmd_ack", &Command::Ack);
    example("cmd_ping_perf", &Command::PingPerf);
    example(
        "cmd_set_integration",
        &Command::SetIntegration {
            name: "test-integration".to_string(),
            version: "1.0.0".to_string(),
        },
    );
    example("cmd_err", &Command::Err);
    example(
        "cmd_add_marker_sample_start",
        &Command::AddMarker {
            pid: 12345,
            marker: MarkerType::SampleStart(1000),
        },
    );
    example(
        "cmd_add_marker_sample_end",
        &Command::AddMarker {
            pid: 12345,
            marker: MarkerType::SampleEnd(2000),
        },
    );
    example(
        "cmd_add_marker_benchmark_start",
        &Command::AddMarker {
            pid: 12345,
            marker: MarkerType::BenchmarkStart(3000),
        },
    );
    example(
        "cmd_add_marker_benchmark_end",
        &Command::AddMarker {
            pid: 12345,
            marker: MarkerType::BenchmarkEnd(4000),
        },
    );
    example("cmd_set_version", &Command::SetVersion(1));
    example("cmd_get_runner_mode", &Command::GetRunnerMode);
    example(
        "cmd_runner_mode_perf",
        &Command::RunnerModeResponse(RunnerMode::Perf),
    );
    example(
        "cmd_runner_mode_simulation",
        &Command::RunnerModeResponse(RunnerMode::Simulation),
    );
    example(
        "cmd_runner_mode_analysis",
        &Command::RunnerModeResponse(RunnerMode::Analysis),
    );
}
