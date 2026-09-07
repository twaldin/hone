const std = @import("std");

// We have to use c_char here, otherwise we redeclare it and cast u8 to char which results in
// additional warnings (-Wbuiltin-declaration-mismatch and -Wpointer-sign).
extern "c" fn printf(format: [*c]const c_char, ...) c_int;

pub const LogLevel = enum(u8) {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
};

var max_level: LogLevel = LogLevel.Debug;

fn logWithPrefix(comptime level: LogLevel, comptime fmt: []const u8, args: anytype) void {
    if (@intFromEnum(level) < @intFromEnum(max_level)) {
        return;
    }

    // Format the message using Zig's formatting
    var buffer: [512]u8 = undefined;
    const prefix_fmt = comptime switch (level) {
        .Debug => "[DEBUG] " ++ fmt,
        .Info => "[INFO] " ++ fmt,
        .Warn => "[WARN] " ++ fmt,
        .Error => "[ERROR] " ++ fmt,
    };

    const msg = std.fmt.bufPrint(buffer[0 .. buffer.len - 1], prefix_fmt, args) catch {
        _ = printf(@as([*c]const c_char, @ptrCast("[ERROR] logger formatting failed\n")));
        return;
    };

    // Null-terminate for printf
    buffer[msg.len] = 0;

    // Print the formatted message (printf with only format string, no args)
    _ = printf(@as([*c]const c_char, @ptrCast(msg.ptr)));
}

pub fn debug(comptime fmt: []const u8, args: anytype) void {
    logWithPrefix(.Debug, fmt, args);
}

pub fn info(comptime fmt: []const u8, args: anytype) void {
    logWithPrefix(.Info, fmt, args);
}

pub fn warn(comptime fmt: []const u8, args: anytype) void {
    logWithPrefix(.Warn, fmt, args);
}

pub fn err(comptime fmt: []const u8, args: anytype) void {
    logWithPrefix(.Error, fmt, args);
}
