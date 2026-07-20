const std = @import("std");
const builtin = @import("builtin");
const walltime = @import("walltime.zig");
const analysis = @import("analysis.zig");
const valgrind = @import("valgrind.zig");
const shared = @import("../shared.zig");
const ValgrindInstrument = valgrind.ValgrindInstrument;
const WalltimeInstrument = walltime.WalltimeInstrument;
const AnalysisInstrument = analysis.AnalysisInstrument;

pub const Instrument = union(enum) {
    valgrind: ValgrindInstrument,
    walltime: WalltimeInstrument,
    analysis: AnalysisInstrument,
    none: void,

    const Self = @This();

    pub fn init(allocator: std.mem.Allocator) !Self {
        // Valgrind/Callgrind client requests only work on Linux.
        if (comptime builtin.os.tag == .linux) {
            if (ValgrindInstrument.init(allocator)) |valgrind_inst| {
                return Self{ .valgrind = valgrind_inst };
            } else |_| {}
        }

        if (AnalysisInstrument.init(allocator)) |analysis_inst| {
            return Self{ .analysis = analysis_inst };
        } else |_| {}

        if (WalltimeInstrument.init(allocator)) |walltime_inst| {
            return Self{ .walltime = walltime_inst };
        } else |_| {}

        return Self{ .none = {} };
    }

    pub inline fn deinit(self: *Self) void {
        switch (self.*) {
            .valgrind => {},
            .walltime => self.walltime.deinit(),
            .analysis => self.analysis.deinit(),
            .none => {},
        }
    }

    pub inline fn is_instrumented(self: *Self) bool {
        return switch (self.*) {
            .valgrind => ValgrindInstrument.is_instrumented(),
            .walltime => true,
            .analysis => true,
            .none => false,
        };
    }

    pub inline fn start_benchmark(self: *Self) !void {
        if (self.* == .walltime) {
            return self.walltime.start_benchmark();
        } else if (self.* == .valgrind) {
            return ValgrindInstrument.start_benchmark();
        } else if (self.* == .analysis) {
            return self.analysis.start_benchmark();
        }
    }

    pub inline fn stop_benchmark(self: *Self) !void {
        if (self.* == .valgrind) {
            return ValgrindInstrument.stop_benchmark();
        } else if (self.* == .walltime) {
            return self.walltime.stop_benchmark();
        } else if (self.* == .analysis) {
            return self.analysis.stop_benchmark();
        }
    }

    pub inline fn set_executed_benchmark(self: *Self, pid: i32, uri: [*c]const u8) !void {
        switch (self.*) {
            .valgrind => ValgrindInstrument.set_executed_benchmark(pid, uri),
            .walltime => try self.walltime.set_executed_benchmark(pid, uri),
            .analysis => try self.analysis.set_executed_benchmark(pid, uri),
            .none => {},
        }
    }

    pub inline fn set_integration(self: *Self, name: [*c]const u8, version: [*c]const u8) !void {
        switch (self.*) {
            .valgrind => try self.valgrind.set_integration(name, version),
            .walltime => try self.walltime.set_integration(name, version),
            .analysis => try self.analysis.set_integration(name, version),
            .none => {},
        }
    }

    pub inline fn add_marker(self: *Self, pid: i32, marker: shared.MarkerType) !void {
        if (self.* == .walltime) {
            return self.walltime.add_marker(pid, marker);
        } else if (self.* == .analysis) {
            return self.analysis.add_marker(pid, marker);
        }
    }
};
