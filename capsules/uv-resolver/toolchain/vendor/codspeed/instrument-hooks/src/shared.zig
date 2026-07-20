const std = @import("std");

// WARNING: Has to be in sync with `runner`

pub const RUNNER_CTL_FIFO = "/tmp/runner.ctl.fifo";
pub const RUNNER_ACK_FIFO = "/tmp/runner.ack.fifo";

// The different markers that can be set in the perf.data.
//
// `SampleStart/End`: Marks the start and end of a sampling period. This is used to differentiate between benchmarks.
// `BenchmarkStart/End`: Marks the start and end of a benchmark. This is used to measure the duration of a benchmark, without the benchmark harness code.
pub const MarkerType = union(enum) {
    SampleStart: u64,
    SampleEnd: u64,
    BenchmarkStart: u64,
    BenchmarkEnd: u64,

    pub fn format(
        self: MarkerType,
        comptime fmt: []const u8,
        options: std.fmt.FormatOptions,
        writer: anytype,
    ) !void {
        _ = fmt;
        _ = options;
        switch (self) {
            .SampleStart => |ts| try writer.print("SampleStart({d})", .{ts}),
            .SampleEnd => |ts| try writer.print("SampleEnd({d})", .{ts}),
            .BenchmarkStart => |ts| try writer.print("BenchmarkStart({d})", .{ts}),
            .BenchmarkEnd => |ts| try writer.print("BenchmarkEnd({d})", .{ts}),
        }
    }

    pub fn equal(self: MarkerType, other: MarkerType) bool {
        return std.meta.eql(self, other);
    }
};

pub const IntegrationMode = enum {
    // Walltime measurement under any profiler (perf, instruments, etc.).
    Walltime,
    Simulation,
    Analysis,
};

pub const Command = union(enum) {
    ExecutedBenchmark: struct {
        pid: i32,
        uri: []const u8,
    },
    StartBenchmark,
    StopBenchmark,
    Ack,
    PingProfiler,
    SetIntegration: struct {
        name: []const u8,
        version: []const u8,
    },
    Err,
    AddMarker: struct {
        pid: i32,
        marker: MarkerType,
    },
    SetVersion: u64,
    GetIntegrationMode,
    IntegrationModeResponse: IntegrationMode,

    pub fn deinit(self: Command, allocator: std.mem.Allocator) void {
        switch (self) {
            .SetIntegration => |data| {
                allocator.free(data.name);
                allocator.free(data.version);
            },
            .ExecutedBenchmark => |data| allocator.free(data.uri),
            .SetVersion => {},
            .GetIntegrationMode => {},
            .IntegrationModeResponse => {},
            else => {},
        }
    }

    pub fn format(
        self: Command,
        comptime fmt: []const u8,
        options: std.fmt.FormatOptions,
        writer: anytype,
    ) !void {
        _ = fmt;
        _ = options;
        switch (self) {
            .ExecutedBenchmark => |data| try writer.print("ExecutedBenchmark {{ pid: {d}, uri: {s} }}", .{ data.pid, data.uri }),
            .StartBenchmark => try writer.writeAll("StartBenchmark"),
            .StopBenchmark => try writer.writeAll("StopBenchmark"),
            .Ack => try writer.writeAll("Ack"),
            .PingProfiler => try writer.writeAll("PingProfiler"),
            .SetIntegration => |data| try writer.print("SetIntegration {{ name: {s}, version: {s} }}", .{ data.name, data.version }),
            .Err => try writer.writeAll("Err"),
            .AddMarker => |data| try writer.print("AddMarker {{ pid: {d}, marker: {} }}", .{ data.pid, data.marker }),
            .SetVersion => |data| try writer.print("SetVersion {{ protocol_version: {d} }}", .{data}),
            .GetIntegrationMode => try writer.writeAll("GetIntegrationMode"),
            .IntegrationModeResponse => |mode| try writer.print("IntegrationModeResponse {}", .{mode}),
        }
    }

    pub fn equal(self: Command, other: Command) bool {
        return switch (self) {
            .ExecutedBenchmark => |self_data| switch (other) {
                .ExecutedBenchmark => |other_data| self_data.pid == other_data.pid and
                    std.mem.eql(u8, self_data.uri, other_data.uri),
                else => false,
            },
            .StartBenchmark => switch (other) {
                .StartBenchmark => true,
                else => false,
            },
            .StopBenchmark => switch (other) {
                .StopBenchmark => true,
                else => false,
            },
            .Ack => switch (other) {
                .Ack => true,
                else => false,
            },
            .PingProfiler => switch (other) {
                .PingProfiler => true,
                else => false,
            },
            .SetIntegration => |self_data| switch (other) {
                .SetIntegration => |other_data| std.mem.eql(u8, self_data.name, other_data.name) and
                    std.mem.eql(u8, self_data.version, other_data.version),
                else => false,
            },
            .Err => switch (other) {
                .Err => true,
                else => false,
            },
            .AddMarker => |self_data| switch (other) {
                .AddMarker => |other_data| self_data.pid == other_data.pid and self_data.marker.equal(other_data.marker),
                else => false,
            },
            .SetVersion => |self_data| switch (other) {
                .SetVersion => |other_data| self_data == other_data,
                else => false,
            },
            .GetIntegrationMode => switch (other) {
                .GetIntegrationMode => true,
                else => false,
            },
            .IntegrationModeResponse => |self_mode| switch (other) {
                .IntegrationModeResponse => |other_mode| self_mode == other_mode,
                else => false,
            },
        };
    }
};
