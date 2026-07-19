const std = @import("std");
const perf = @import("perf.zig");
const analysis = @import("analysis.zig");
const valgrind = @import("valgrind.zig");
const shared = @import("../shared.zig");
const ValgrindInstrument = valgrind.ValgrindInstrument;
const PerfInstrument = perf.PerfInstrument;
const AnalysisInstrument = analysis.AnalysisInstrument;

pub const InstrumentHooks = union(enum) {
    valgrind: ValgrindInstrument,
    perf: PerfInstrument,
    analysis: AnalysisInstrument,
    none: void,

    const Self = @This();

    pub fn init(allocator: std.mem.Allocator) !Self {
        if (ValgrindInstrument.init(allocator)) |valgrind_inst| {
            return Self{ .valgrind = valgrind_inst };
        } else |_| {}

        if (AnalysisInstrument.init(allocator)) |analysis_inst| {
            return Self{ .analysis = analysis_inst };
        } else |_| {}

        if (PerfInstrument.init(allocator)) |perf_inst| {
            return Self{ .perf = perf_inst };
        } else |_| {}

        return Self{ .none = {} };
    }

    pub inline fn deinit(self: *Self) void {
        switch (self.*) {
            .valgrind => {},
            .perf => self.perf.deinit(),
            .analysis => self.analysis.deinit(),
            .none => {},
        }
    }

    pub inline fn is_instrumented(self: *Self) bool {
        return switch (self.*) {
            .valgrind => ValgrindInstrument.is_instrumented(),
            .perf => true,
            .analysis => true,
            .none => false,
        };
    }

    pub inline fn start_benchmark(self: *Self) !void {
        if (self.* == .perf) {
            return self.perf.start_benchmark();
        } else if (self.* == .valgrind) {
            return ValgrindInstrument.start_benchmark();
        } else if (self.* == .analysis) {
            return self.analysis.start_benchmark();
        }
    }

    pub inline fn stop_benchmark(self: *Self) !void {
        if (self.* == .valgrind) {
            return ValgrindInstrument.stop_benchmark();
        } else if (self.* == .perf) {
            return self.perf.stop_benchmark();
        } else if (self.* == .analysis) {
            return self.analysis.stop_benchmark();
        }
    }

    pub inline fn set_executed_benchmark(self: *Self, pid: u32, uri: [*c]const u8) !void {
        switch (self.*) {
            .valgrind => ValgrindInstrument.set_executed_benchmark(pid, uri),
            .perf => try self.perf.set_executed_benchmark(pid, uri),
            .analysis => try self.analysis.set_executed_benchmark(pid, uri),
            .none => {},
        }
    }

    pub inline fn set_integration(self: *Self, name: [*c]const u8, version: [*c]const u8) !void {
        switch (self.*) {
            .valgrind => try self.valgrind.set_integration(name, version),
            .perf => try self.perf.set_integration(name, version),
            .analysis => try self.analysis.set_integration(name, version),
            .none => {},
        }
    }

    pub inline fn add_marker(self: *Self, pid: u32, marker: shared.MarkerType) !void {
        if (self.* == .perf) {
            return self.perf.add_marker(pid, marker);
        } else if (self.* == .analysis) {
            return self.analysis.add_marker(pid, marker);
        }
    }
};
