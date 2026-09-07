const std = @import("std");
const instruments = @import("./instruments/root.zig");
const environment = @import("./environment/root.zig");

const Instrument = instruments.Instrument;
const Environment = environment.Environment;

pub const InstrumentHooks = struct {
    instrument: Instrument,
    environment: Environment,

    const Self = @This();

    pub fn init(allocator: std.mem.Allocator) !Self {
        return .{
            .instrument = try Instrument.init(allocator),
            .environment = Environment.init(allocator),
        };
    }

    pub fn deinit(self: *Self) void {
        self.instrument.deinit();
        self.environment.deinit();
    }
};
