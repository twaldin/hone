const std = @import("std");
const builtin = @import("builtin");

pub fn main() !void {
    const out = std.io.getStdOut().writer();
    for (builtin.test_functions) |t| {
        std.testing.allocator_instance = .{};

        const name = extractName(t);
        const result = t.func();
        if (result) |_| {
            try std.fmt.format(out, "[SUCCESS] {s}\n", .{name});
        } else |err| {
            try std.fmt.format(out, "[FAIL] {s}: {}\n", .{ t.name, err });
        }

        if (std.testing.allocator_instance.deinit() == .leak) {
            try std.fmt.format(out, "{s} leaked memory\n", .{name});
        }
    }
}

fn extractName(t: std.builtin.TestFn) []const u8 {
    const marker = std.mem.lastIndexOf(u8, t.name, ".test.") orelse return t.name;
    return t.name[marker + 6 ..];
}
