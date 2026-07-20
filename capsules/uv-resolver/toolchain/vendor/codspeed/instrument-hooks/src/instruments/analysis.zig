const shared = @import("../shared.zig");
const fifo_instrument = @import("fifo_instrument.zig");

const AnalysisError = error{ModeError};

pub const AnalysisInstrument = fifo_instrument.FifoInstrument(.Analysis, AnalysisError);
