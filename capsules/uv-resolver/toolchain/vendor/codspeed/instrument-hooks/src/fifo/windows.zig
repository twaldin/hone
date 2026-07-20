//! Windows fifo backend — not yet implemented.
//!
//! Real implementation would use Win32 named pipes:
//!   CreateNamedPipeA(\\.\pipe\runner.ctl, ...) for the runner-side endpoints,
//!   CreateFileA(\\.\pipe\runner.ctl, ...) on the hooks side, plus
//!   PeekNamedPipe / SetNamedPipeHandleState(PIPE_NOWAIT) for the non-blocking
//!   semantics that the POSIX impl gets via O_NONBLOCK + fcntl.
//!
//! For now every entry point returns error.Unsupported so callers (runner_fifo,
//! the C FFI exports) propagate a non-zero status and the runtime falls back to
//! the "none" instrument backend.

const std = @import("std");
const shared = @import("../shared.zig");

const Allocator = std.mem.Allocator;
pub const Command = shared.Command;

pub const Pipe = struct {
    pub const Reader = struct {
        pub fn read(_: *Reader, _: []u8) !usize {
            return error.Unsupported;
        }
        pub fn readAll(_: *Reader, _: []u8) !usize {
            return error.Unsupported;
        }
        pub fn recvCmd(_: *Reader) !Command {
            return error.Unsupported;
        }
        pub fn waitForResponse(_: *Reader, _: ?u64) !Command {
            return error.Unsupported;
        }
        pub fn waitForAck(_: *Reader, _: ?u64) !void {
            return error.Unsupported;
        }
        pub fn deinit(_: *Reader) void {}
    };

    pub const Writer = struct {
        pub fn write(_: *Writer, _: []const u8) !usize {
            return error.Unsupported;
        }
        pub fn writeAll(_: *Writer, _: []const u8) !void {
            return error.Unsupported;
        }
        pub fn sendCmd(_: *Writer, _: Command) !void {
            return error.Unsupported;
        }
        pub fn deinit(_: *Writer) void {}
    };

    pub fn create(_: [*:0]const u8) !void {
        return error.Unsupported;
    }

    pub fn openRead(_: Allocator, _: []const u8) !Reader {
        return error.Unsupported;
    }

    pub fn openWrite(_: Allocator, _: []const u8) !Writer {
        return error.Unsupported;
    }
};

pub fn sendCmd(_: Allocator, _: Command) !void {
    return error.Unsupported;
}

pub fn sendVersion(_: Allocator, _: u64) !void {
    return error.Unsupported;
}
