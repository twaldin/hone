const shared = @import("../shared.zig");
const fifo_instrument = @import("fifo_instrument.zig");

const PerfError = error{ModeError};

pub const PerfInstrument = fifo_instrument.FifoInstrument(.Perf, PerfError);
