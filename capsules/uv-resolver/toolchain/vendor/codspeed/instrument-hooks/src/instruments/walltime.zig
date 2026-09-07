const shared = @import("../shared.zig");
const fifo_instrument = @import("fifo_instrument.zig");

const WalltimeError = error{ModeError};

pub const WalltimeInstrument = fifo_instrument.FifoInstrument(.Walltime, WalltimeError);
