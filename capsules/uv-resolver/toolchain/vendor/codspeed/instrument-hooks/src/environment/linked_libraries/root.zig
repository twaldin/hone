//! Collects metadata about dynamically linked libraries loaded in the current process.
//!
//! Uses dl_iterate_phdr to walk loaded ELF objects, then parses their in-memory
//! program headers to extract structured metadata. No file I/O is performed —
//! everything is read from already-mapped memory.

const std = @import("std");
const builtin = @import("builtin");
const logger = @import("../../logger.zig");
const elf = std.elf;
pub const ElfView = @import("elf_view.zig");

pub const LibraryInfo = struct {
    /// Resolved path on disk (e.g. "/usr/lib/x86_64-linux-gnu/libc.so.6")
    path: []const u8,
    /// Library's own SONAME from DT_SONAME (e.g. "libc.so.6"), if present
    soname: ?[]const u8,
    /// GNU Build ID from PT_NOTE as hex string (e.g. "a1b2c3d4..."), if present
    build_id: ?[]const u8,
};

/// JSON-serializable entry for a linked library (soname is used as the map key).
pub const LibraryEntry = struct {
    path: []const u8,
    build_id: ?[]const u8,
};

fn hexEncode(allocator: std.mem.Allocator, bytes: []const u8) ?[]const u8 {
    const hex = allocator.alloc(u8, bytes.len * 2) catch return null;
    const hex_chars = "0123456789abcdef";
    for (bytes, 0..) |byte, i| {
        hex[i * 2] = hex_chars[byte >> 4];
        hex[i * 2 + 1] = hex_chars[byte & 0x0f];
    }
    return hex;
}

pub const LinkedLibraries = struct {
    allocator: std.mem.Allocator,
    libraries: std.ArrayList(LibraryInfo),

    const Self = @This();
    const empty_strings: []const []const u8 = &.{};

    pub fn init(alloc: std.mem.Allocator) Self {
        return .{
            .allocator = alloc,
            .libraries = std.ArrayList(LibraryInfo).init(alloc),
        };
    }

    pub fn deinit(self: *Self) void {
        for (self.libraries.items) |lib| {
            freeLibraryInfo(self.allocator, lib);
        }
        self.libraries.deinit();
    }

    fn freeLibraryInfo(allocator: std.mem.Allocator, lib: LibraryInfo) void {
        allocator.free(lib.path);
        if (lib.soname) |s| allocator.free(s);
        if (lib.build_id) |b| allocator.free(b);
    }

    fn extractLibraryInfo(allocator: std.mem.Allocator, view: ElfView, path: []const u8) ?LibraryInfo {
        const build_id = if (view.buildId()) |bytes| hexEncode(allocator, bytes) else null;

        const dyn_entries = view.dynamicEntries() orelse {
            return .{
                .path = allocator.dupe(u8, path) catch return null,
                .soname = null,
                .build_id = build_id,
            };
        };

        const strtab_ptr = ElfView.strtab(dyn_entries) orelse return null;

        const soname_str = if (ElfView.soname(dyn_entries, strtab_ptr)) |s|
            allocator.dupe(u8, s) catch return null
        else
            null;

        return .{
            .path = allocator.dupe(u8, path) catch return null,
            .soname = soname_str,
            .build_id = build_id,
        };
    }

    pub fn collect(self: *Self) !void {
        // ELF dl_iterate_phdr with full dl_phdr_info fields is only available on Linux.
        if (comptime builtin.os.tag != .linux) return;

        for (self.libraries.items) |lib| {
            freeLibraryInfo(self.allocator, lib);
        }
        self.libraries.clearRetainingCapacity();

        const ret = std.c.dl_iterate_phdr(&struct {
            fn callback(info: *std.c.dl_phdr_info, _: usize, data: ?*anyopaque) callconv(.c) c_int {
                const self_ptr: *Self = @ptrCast(@alignCast(data));
                const name = std.mem.span(info.name orelse return 0);

                if (name.len == 0) return 0;
                if (std.mem.startsWith(u8, name, "linux-vdso")) return 0;

                const view = ElfView.init(info.addr, info.phdr, info.phnum);
                const lib_info = extractLibraryInfo(self_ptr.allocator, view, name) orelse return -1;
                self_ptr.libraries.append(lib_info) catch return -1;
                return 0;
            }
        }.callback, @ptrCast(self));

        if (ret != 0) return error.DlIteratePhdrFailed;
    }

    pub fn log(self: *const Self) void {
        logger.info("instrument-hooks: collected {d} linked libraries:\n", .{self.libraries.items.len});
        for (self.libraries.items) |lib| {
            if (lib.soname) |s| {
                logger.info("  - {s} (soname: {s})\n", .{ lib.path, s });
            } else {
                logger.info("  - {s}\n", .{lib.path});
            }
            if (lib.build_id) |bid| {
                logger.info("      build-id: {s}\n", .{bid});
            }
        }
    }
};

// --- Tests ---

test "collect linked libraries" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;

    var libs = LinkedLibraries.init(std.testing.allocator);
    defer libs.deinit();

    try libs.collect();
    try std.testing.expect(libs.libraries.items.len > 0);

    var found_libc = false;
    for (libs.libraries.items) |lib| {
        if (std.mem.indexOf(u8, lib.path, "libc") != null) {
            found_libc = true;
            try std.testing.expect(lib.soname != null);
            try std.testing.expectEqualStrings("libc.so.6", lib.soname.?);
            try std.testing.expect(lib.build_id != null);
            try std.testing.expect(lib.build_id.?.len > 0);
            break;
        }
    }
    try std.testing.expect(found_libc);
}
