const std = @import("std");
const fs = std.fs;
const logger = @import("../logger.zig");
const linked_libraries = @import("linked_libraries/root.zig");

extern "c" fn getenv(name: [*:0]const u8) ?[*:0]const u8;

/// A value in the integration environment: either a single string or a list of strings.
pub const EnvironmentValue = union(enum) {
    string: []const u8,
    list: []const []const u8,

    pub fn jsonStringify(self: @This(), jw: anytype) !void {
        switch (self) {
            .string => |s| try jw.write(s),
            .list => |l| try jw.write(l),
        }
    }
};

/// Self-reported environment information provided by integrations (e.g. compiler version, runtime details).
const IntegrationEnvironmentEntries = std.json.ArrayHashMap(EnvironmentValue);
const IntegrationEnvironmentMap = std.json.ArrayHashMap(IntegrationEnvironmentEntries);

const LinkedLibrariesMap = std.json.ArrayHashMap(linked_libraries.LibraryEntry);

const EnvironmentJson = struct {
    integration_environment: IntegrationEnvironmentMap = .{},
    linked_libraries: LinkedLibrariesMap = .{},
};

pub const Environment = struct {
    allocator: std.mem.Allocator,
    data: EnvironmentJson = .{},
    libs: linked_libraries.LinkedLibraries,

    const Self = @This();

    pub fn init(alloc: std.mem.Allocator) Self {
        return .{
            .allocator = alloc,
            .libs = linked_libraries.LinkedLibraries.init(alloc),
        };
    }

    pub fn deinit(self: *Self) void {
        var int_it = self.data.integration_environment.map.iterator();
        while (int_it.next()) |int_entry| {
            var entry_it = int_entry.value_ptr.map.iterator();
            while (entry_it.next()) |kv| {
                self.allocator.free(kv.key_ptr.*);
                self.freeEnvironmentValue(kv.value_ptr.*);
            }
            int_entry.value_ptr.map.deinit(self.allocator);
            self.allocator.free(int_entry.key_ptr.*);
        }
        self.data.integration_environment.map.deinit(self.allocator);

        var ll_it = self.data.linked_libraries.map.iterator();
        while (ll_it.next()) |ll_entry| {
            self.allocator.free(ll_entry.key_ptr.*);
        }
        self.data.linked_libraries.map.deinit(self.allocator);

        self.libs.deinit();
    }

    pub fn setIntegrationEnvironment(self: *Self, integration_name: []const u8, key: []const u8, value: []const u8) !void {
        try self.setIntegrationEnvironmentValue(integration_name, key, .{ .string = try self.allocator.dupe(u8, value) });
    }

    pub fn setIntegrationEnvironmentList(self: *Self, integration_name: []const u8, key: []const u8, values: []const []const u8) !void {
        const duped = try self.allocator.alloc([]const u8, values.len);
        var i: usize = 0;
        errdefer {
            for (duped[0..i]) |item| self.allocator.free(item);
            self.allocator.free(duped);
        }
        while (i < values.len) : (i += 1) {
            duped[i] = try self.allocator.dupe(u8, values[i]);
        }
        try self.setIntegrationEnvironmentValue(integration_name, key, .{ .list = duped });
    }

    fn freeEnvironmentValue(self: *Self, val: EnvironmentValue) void {
        switch (val) {
            .string => |s| self.allocator.free(s),
            .list => |l| {
                for (l) |item| self.allocator.free(item);
                self.allocator.free(l);
            },
        }
    }

    fn setIntegrationEnvironmentValue(self: *Self, integration_name: []const u8, key: []const u8, value: EnvironmentValue) !void {
        const int_gop = try self.data.integration_environment.map.getOrPut(self.allocator, integration_name);
        if (!int_gop.found_existing) {
            int_gop.key_ptr.* = try self.allocator.dupe(u8, integration_name);
            int_gop.value_ptr.* = .{};
        }

        const entry_gop = try int_gop.value_ptr.map.getOrPut(self.allocator, key);
        if (entry_gop.found_existing) {
            self.freeEnvironmentValue(entry_gop.value_ptr.*);
        } else {
            entry_gop.key_ptr.* = try self.allocator.dupe(u8, key);
        }
        entry_gop.value_ptr.* = value;
    }

    fn populateLinkedLibraries(self: *Self) !void {
        // Clear existing entries
        var ll_it = self.data.linked_libraries.map.iterator();
        while (ll_it.next()) |ll_entry| {
            self.allocator.free(ll_entry.key_ptr.*);
        }
        self.data.linked_libraries.map.clearRetainingCapacity();

        for (self.libs.libraries.items) |lib| {
            const key = lib.soname orelse lib.path;
            const gop = try self.data.linked_libraries.map.getOrPut(self.allocator, key);
            gop.key_ptr.* = try self.allocator.dupe(u8, key);
            gop.value_ptr.* = .{
                .path = lib.path,
                .build_id = lib.build_id,
            };
        }
    }

    pub fn writeEnvironment(self: *Self, pid: i32) u8 {
        self.libs.collect() catch {
            logger.err("instrument-hooks: failed to collect linked libraries\n", .{});
        };
        self.populateLinkedLibraries() catch {
            logger.err("instrument-hooks: failed to populate linked libraries\n", .{});
        };

        if (self.data.integration_environment.map.count() == 0 and self.data.linked_libraries.map.count() == 0) return 0;

        const profile_folder = getenv("CODSPEED_PROFILE_FOLDER") orelse {
            return 0;
        };

        const folder_slice = std.mem.span(profile_folder);

        var path_buf: [512]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "{s}/environment-{d}.json", .{ folder_slice, pid }) catch {
            logger.err("instrument-hooks: profile folder path too long\n", .{});
            return 1;
        };

        // Serialize and write
        const json = std.json.stringifyAlloc(self.allocator, self.data, .{ .whitespace = .indent_2 }) catch {
            logger.err("instrument-hooks: failed to serialize environment JSON\n", .{});
            return 1;
        };
        defer self.allocator.free(json);

        const file = fs.createFileAbsolute(path, .{}) catch {
            logger.err("instrument-hooks: failed to write environment.json\n", .{});
            return 1;
        };
        defer file.close();

        file.writeAll(json) catch {
            logger.err("instrument-hooks: failed to write environment.json\n", .{});
            return 1;
        };

        return 0;
    }
};

// --- Tests ---

test "set and retrieve section entries" {
    var env = Environment.init(std.testing.allocator);
    defer env.deinit();

    try env.setIntegrationEnvironment("gcc", "version", "14.2.0");
    try env.setIntegrationEnvironment("gcc", "build", "g++ (Ubuntu 14.2.0-4ubuntu2) 14.2.0");
    try env.setIntegrationEnvironment("clang", "version", "18.1.0");

    try std.testing.expectEqual(@as(usize, 2), env.data.integration_environment.map.count());
    try std.testing.expectEqual(@as(usize, 2), env.data.integration_environment.map.get("gcc").?.map.count());
    try std.testing.expectEqual(@as(usize, 1), env.data.integration_environment.map.get("clang").?.map.count());
}

test "overwrite existing entry" {
    var env = Environment.init(std.testing.allocator);
    defer env.deinit();

    try env.setIntegrationEnvironment("gcc", "version", "13.0.0");
    try env.setIntegrationEnvironment("gcc", "version", "14.2.0");

    try std.testing.expectEqual(@as(usize, 1), env.data.integration_environment.map.count());
    try std.testing.expectEqualStrings("14.2.0", env.data.integration_environment.map.get("gcc").?.map.get("version").?.string);
}

test "json serialization" {
    var env = Environment.init(std.testing.allocator);
    defer env.deinit();

    try env.setIntegrationEnvironment("gcc", "version", "14.2.0");
    try env.setIntegrationEnvironment("gcc", "build", "g++ (Ubuntu 14.2.0)");
    try env.setIntegrationEnvironment("clang", "version", "18.1.0");

    const json = try std.json.stringifyAlloc(std.testing.allocator, env.data, .{ .whitespace = .indent_2 });
    defer std.testing.allocator.free(json);

    try std.testing.expect(std.mem.indexOf(u8, json, "\"version\": \"14.2.0\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"build\": \"g++ (Ubuntu 14.2.0)\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"version\": \"18.1.0\"") != null);
}

test "empty sections" {
    var env = Environment.init(std.testing.allocator);
    defer env.deinit();

    const json = try std.json.stringifyAlloc(std.testing.allocator, env.data, .{ .whitespace = .indent_2 });
    defer std.testing.allocator.free(json);

    try std.testing.expectEqualStrings(
        \\{
        \\  "integration_environment": {},
        \\  "linked_libraries": {}
        \\}
    , json);
}

test "json escaping" {
    var env = Environment.init(std.testing.allocator);
    defer env.deinit();

    try env.setIntegrationEnvironment("test", "path", "C:\\Program Files\\gcc");

    const json = try std.json.stringifyAlloc(std.testing.allocator, env.data, .{ .whitespace = .indent_2 });
    defer std.testing.allocator.free(json);

    // Backslashes should be escaped in JSON
    try std.testing.expect(std.mem.indexOf(u8, json, "C:\\\\Program Files\\\\gcc") != null);
}

test "merge preserves existing and adds new" {
    var env = Environment.init(std.testing.allocator);
    defer env.deinit();

    // Simulate existing data parsed from file
    try env.setIntegrationEnvironment("python", "version", "3.12.0");

    // Add new section
    try env.setIntegrationEnvironment("cpp", "version", "14.2.0");

    try std.testing.expectEqual(@as(usize, 2), env.data.integration_environment.map.count());

    const json = try std.json.stringifyAlloc(std.testing.allocator, env.data, .{ .whitespace = .indent_2 });
    defer std.testing.allocator.free(json);

    try std.testing.expect(std.mem.indexOf(u8, json, "\"python\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"cpp\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"3.12.0\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"14.2.0\"") != null);
}

test "new entries override existing on merge" {
    var env = Environment.init(std.testing.allocator);
    defer env.deinit();

    try env.setIntegrationEnvironment("python", "version", "3.12.0");
    try env.setIntegrationEnvironment("python", "version", "3.13.0");

    try std.testing.expectEqual(@as(usize, 1), env.data.integration_environment.map.count());
    try std.testing.expectEqualStrings("3.13.0", env.data.integration_environment.map.get("python").?.map.get("version").?.string);
}

test "list environment value" {
    var env = Environment.init(std.testing.allocator);
    defer env.deinit();

    try env.setIntegrationEnvironmentList("python", "sys_path", &.{ "/usr/lib/python3.13", "/home/user/.venv/lib" });
    try env.setIntegrationEnvironment("python", "version", "3.13.0");

    const json = try std.json.stringifyAlloc(std.testing.allocator, env.data, .{ .whitespace = .indent_2 });
    defer std.testing.allocator.free(json);

    try std.testing.expect(std.mem.indexOf(u8, json, "\"version\": \"3.13.0\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"sys_path\": [") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"/usr/lib/python3.13\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"/home/user/.venv/lib\"") != null);
}

test "overwrite string with list" {
    var env = Environment.init(std.testing.allocator);
    defer env.deinit();

    try env.setIntegrationEnvironment("python", "paths", "old_value");
    try env.setIntegrationEnvironmentList("python", "paths", &.{ "/a", "/b" });

    try std.testing.expectEqual(@as(usize, 1), env.data.integration_environment.map.get("python").?.map.count());
    const val = env.data.integration_environment.map.get("python").?.map.get("paths").?;
    try std.testing.expectEqual(@as(usize, 2), val.list.len);
}

test "linked libraries serialization" {
    const alloc = std.testing.allocator;
    var env = Environment.init(alloc);
    defer env.deinit();

    try env.libs.libraries.append(.{
        .path = try alloc.dupe(u8, "/usr/lib/libc.so.6"),
        .soname = try alloc.dupe(u8, "libc.so.6"),
        .build_id = try alloc.dupe(u8, "abc123"),
    });

    try env.libs.libraries.append(.{
        .path = try alloc.dupe(u8, "/usr/lib/libm.so.6"),
        .soname = null,
        .build_id = null,
    });

    try env.populateLinkedLibraries();

    const json = try std.json.stringifyAlloc(alloc, env.data, .{ .whitespace = .indent_2 });
    defer alloc.free(json);

    // Library with soname is keyed by soname
    try std.testing.expect(std.mem.indexOf(u8, json, "\"libc.so.6\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"/usr/lib/libc.so.6\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"abc123\"") != null);

    // Library without soname is keyed by path
    try std.testing.expect(std.mem.indexOf(u8, json, "\"/usr/lib/libm.so.6\"") != null);
}
