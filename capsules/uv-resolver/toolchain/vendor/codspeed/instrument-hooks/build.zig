const std = @import("std");

pub fn build(b: *std.Build) void {
    // Core Library — one per OS, transpiled to C via .ofmt = .c.
    const PerOsTarget = struct { name: []const u8, query: std.Target.Query };
    const targets = [_]PerOsTarget{
        .{ .name = "core.linux", .query = .{
            .cpu_arch = .x86_64,
            .os_tag = .linux,
            .abi = .gnu,
            .ofmt = .c,
        } },
        .{ .name = "core.macos", .query = .{
            .cpu_arch = .x86_64,
            .os_tag = .macos,
            .abi = .none,
            .ofmt = .c,
        } },
    };
    for (targets) |t| {
        const lib = b.addStaticLibrary(.{
            .name = t.name,
            .root_source_file = b.path("src/c.zig"),
            .target = b.resolveTargetQuery(t.query),
            .optimize = .ReleaseSmall,
            .link_libc = true,
            .strip = true,
            .pic = true,
        });
        lib.no_builtin = true;
        b.installArtifact(lib);
    }

    // Test shared library fixture
    //
    // Builds a tiny .so used by ElfView tests. The tests dlopen() it at runtime
    // so they exercise the real dl_iterate_phdr path against a known binary.
    const test_lib = b.addSharedLibrary(.{
        .name = "test_fixture",
        .target = b.graph.host,
        .optimize = .Debug,
        .link_libc = true,
    });
    test_lib.addCSourceFile(.{ .file = b.path("src/environment/linked_libraries/testdata/test_lib.c") });
    test_lib.version_script = b.path("src/environment/linked_libraries/testdata/test_lib.ver");
    test_lib.build_id = std.zig.BuildId.parse("0xdeadbeef") catch unreachable;

    // Tests
    //
    const test_main = b.addTest(.{ .root_source_file = b.path("src/root.zig"), .optimize = .ReleaseSafe, .link_libc = true, .test_runner = .{ .path = b.path("src/tests/runner.zig"), .mode = .simple } });
    test_main.addCSourceFile(.{ .file = b.path("src/helpers/valgrind_wrapper.c") });
    test_main.addIncludePath(b.path("includes"));
    test_main.linkLibC();
    // Link the test .so so it appears in dl_iterate_phdr during ElfView tests
    test_main.addLibraryPath(test_lib.getEmittedBin().dirname());
    test_main.addRPath(test_lib.getEmittedBin().dirname());
    test_main.linkSystemLibrary2("test_fixture", .{ .preferred_link_mode = .dynamic });
    const run_test_main = b.addRunArtifact(test_main);
    b.step("test", "test utility functions").dependOn(&run_test_main.step);
}
