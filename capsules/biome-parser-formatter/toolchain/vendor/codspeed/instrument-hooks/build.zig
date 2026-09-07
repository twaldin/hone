const std = @import("std");

pub fn build(b: *std.Build) void {
    // Core Library
    //
    const libcore = b.addStaticLibrary(.{
        .name = "core",
        .root_source_file = b.path("src/c.zig"),
        .target = b.resolveTargetQuery(.{ .ofmt = .c }),
        .optimize = .ReleaseSmall,
        .link_libc = true,
        .strip = true,
        .pic = true,
    });
    libcore.no_builtin = true;
    b.installArtifact(libcore);

    // Tests
    //
    const test_main = b.addTest(.{ .root_source_file = b.path("src/root.zig"), .optimize = .ReleaseSafe, .link_libc = true, .test_runner = .{ .path = b.path("src/tests/runner.zig"), .mode = .simple } });
    test_main.addCSourceFile(.{ .file = b.path("src/helpers/valgrind_wrapper.c") });
    test_main.addIncludePath(b.path("includes"));
    test_main.linkLibC();
    const run_test_main = b.addRunArtifact(test_main);
    b.step("test", "test utility functions").dependOn(&run_test_main.step);
}
