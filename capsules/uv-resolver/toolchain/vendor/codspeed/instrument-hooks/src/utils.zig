const std = @import("std");
const builtin = @import("builtin");
const c = @cImport(@cInclude("time.h"));
const errno = @cImport(@cInclude("errno.h"));

extern "c" fn printf(format: [*c]const c_char, ...) c_int;

// Win32 Sleep takes milliseconds. Declared here (not pulled from std.os.windows)
// because std uses inline syscalls / per-arch glue we don't want in transpiled C.
extern "kernel32" fn Sleep(dwMilliseconds: u32) callconv(.winapi) void;

// Note: Using printf to avoid the extra code from std.log/std.debug. Those won't
// compile because they are internally using syscalls (for Mutexes) which aren't cross-platform.
//
// This wrapper converts Zig string literals to null-terminated c_char arrays and handles
// variadic argument forwarding to the C printf function.
pub fn print(comptime fmt: []const u8, args: anytype) void {
    // Create a comptime null-terminated c_char array from the format string
    const fmt_z = comptime blk: {
        var buf: [fmt.len:0]c_char = undefined;
        for (fmt, 0..) |byte, i| {
            buf[i] = byte;
        }
        buf[fmt.len] = 0;
        break :blk buf;
    };

    _ = @call(.auto, printf, .{&fmt_z} ++ args);
}

// Sleep for at least the given number of nanoseconds.
//
// Avoids std.Thread.sleep / std.time.sleep because those use inline syscalls on
// Linux that aren't portable across architectures. On POSIX we go straight to
// nanosleep; on Windows we fall back to Sleep (millisecond resolution).
pub fn sleep(nanoseconds: u64) void {
    if (builtin.os.tag == .windows) {
        const ms_u64 = nanoseconds / std.time.ns_per_ms;
        const ms: u32 = @intCast(@min(ms_u64, std.math.maxInt(u32)));
        Sleep(ms);
        return;
    }

    const s = nanoseconds / std.time.ns_per_s;
    const ns = nanoseconds % std.time.ns_per_s;

    var req: c.struct_timespec = .{
        .tv_sec = std.math.cast(c.time_t, s) orelse std.math.maxInt(c.time_t),
        .tv_nsec = std.math.cast(c_long, ns) orelse std.math.maxInt(c_long),
    };
    var rem: c.struct_timespec = undefined;

    while (true) {
        const ret = c.nanosleep(&req, &rem);

        if (ret == errno.EINTR) {
            req = rem;
            continue;
        } else {
            return;
        }
    }
}

test "sleep for at least 1 second" {
    const start = try std.time.Instant.now();
    sleep(1 * std.time.ns_per_s);
    const end = try std.time.Instant.now();

    const elapsed_ns: u64 = end.since(start);
    const elapsed_s = elapsed_ns / std.time.ns_per_s;

    std.debug.assert(elapsed_s >= 1);
    std.debug.assert(elapsed_s < 2);
}

test "print function works without crashing" {
    // Test with no arguments
    print("Hello, World!\n", .{});

    // Test with string argument
    print("Hello, %s!\n", .{"Zig"});

    // Test with multiple arguments
    print("Number: %d, String: %s\n", .{ @as(c_int, 42), "test" });

    // Test with format specifiers that need proper types
    print("Precision test: %.*s\n", .{ @as(c_int, 5), "HelloWorld" });
}
