const builtin = @import("builtin");
const std = @import("std");
const math = std.math;

pub extern "C" fn running_on_valgrind() u8;
pub extern "C" fn callgrind_dump_stats() void;
pub extern "C" fn callgrind_dump_stats_at(pos_str: [*:0]const u8) void;
pub extern "C" fn callgrind_zero_stats() void;
pub extern "C" fn callgrind_start_instrumentation() void;
pub extern "C" fn callgrind_stop_instrumentation() void;
