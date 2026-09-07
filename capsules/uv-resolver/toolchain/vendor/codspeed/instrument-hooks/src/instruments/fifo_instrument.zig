const std = @import("std");
const runner_fifo = @import("../runner_fifo.zig");
const shared = @import("../shared.zig");

/// Creates a complete FIFO-based instrument struct that validates a specific integration mode
pub fn FifoInstrument(comptime mode: shared.IntegrationMode, comptime error_type: anytype) type {
    return struct {
        fifo: runner_fifo.RunnerFifo,

        const Self = @This();

        pub fn init(allocator: std.mem.Allocator) !Self {
            var fifo = try runner_fifo.RunnerFifo.init(allocator);

            // Ensure both the runner and integration FIFO are compatible
            try fifo.validate_protocol_version();

            // Get the instrumentation mode from the runner
            const detected_mode = fifo.get_integration_mode() catch |err| {
                fifo.deinit();
                return err;
            };

            // Only accept if the runner is in the correct mode
            if (detected_mode != mode) {
                fifo.deinit();
                return error_type.ModeError;
            }

            return Self{ .fifo = fifo };
        }

        pub fn deinit(self: *Self) void {
            self.fifo.deinit();
        }

        pub fn send_version(self: *Self, protocol_version: u64) !void {
            try self.fifo.send_version(protocol_version);
        }

        pub fn start_benchmark(self: *Self) !void {
            try self.fifo.start_benchmark();
        }

        pub fn stop_benchmark(self: *Self) !void {
            try self.fifo.stop_benchmark();
        }

        pub fn set_executed_benchmark(self: *Self, pid: i32, uri: [*c]const u8) !void {
            try self.fifo.set_executed_benchmark(pid, uri);
        }

        pub fn set_integration(self: *Self, name: [*c]const u8, version: [*c]const u8) !void {
            try self.fifo.set_integration(name, version);
        }

        pub fn add_marker(self: *Self, pid: i32, marker: shared.MarkerType) !void {
            try self.fifo.add_marker(pid, marker);
        }
    };
}
