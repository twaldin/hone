const std = @import("std");
const builtin = @import("builtin");

pub fn main() !void {
    const out = std.io.getStdOut().writer();
    var has_failures = false;
    for (builtin.test_functions) |t| {
        std.testing.allocator_instance = .{};

        const name = extractName(t);
        const result = t.func();
        if (result) |_| {
            try std.fmt.format(out, "[SUCCESS] {s}\n", .{name});
        } else |err| switch (err) {
            error.SkipZigTest => try std.fmt.format(out, "[SKIP] {s}\n", .{name}),
            else => {
                has_failures = true;
                try std.fmt.format(out, "[FAIL] {s}: {}\n", .{ t.name, err });
            },
        }

        if (std.testing.allocator_instance.deinit() == .leak) {
            has_failures = true;
            try std.fmt.format(out, "{s} leaked memory\n", .{name});
        }
    }
    if (has_failures) std.process.exit(1);
}

fn extractName(t: std.builtin.TestFn) []const u8 {
    const marker = std.mem.lastIndexOf(u8, t.name, ".test.") orelse return t.name;
    return t.name[marker + 6 ..];
}
