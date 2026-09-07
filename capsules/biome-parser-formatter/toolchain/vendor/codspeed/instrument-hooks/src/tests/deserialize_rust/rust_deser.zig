const std = @import("std");
const shared = @import("../../shared.zig");
const Command = shared.Command;

fn assert_eq(serialized: []const u8, expected_cmd: Command) !void {
    const bincode = @import("../../bincode.zig");

    var stream = std.io.fixedBufferStream(serialized);
    const deserialized_cmd = try bincode.deserializeAlloc(stream.reader(), std.testing.allocator, Command);
    defer deserialized_cmd.deinit(std.testing.allocator);

    try std.testing.expect(expected_cmd.equal(deserialized_cmd));
}

test "rust deserialization" {
    const rust = @import("serialized.zig");

    try assert_eq(rust.cmd_cur_bench, Command{ .ExecutedBenchmark = .{
        .pid = 12345,
        .uri = "http://example.com/benchmark",
    } });
    try assert_eq(rust.cmd_start_bench, Command{ .StartBenchmark = {} });
    try assert_eq(rust.cmd_stop_bench, Command{ .StopBenchmark = {} });
    try assert_eq(rust.cmd_ack, Command{ .Ack = {} });
    try assert_eq(rust.cmd_ping_perf, Command{ .PingPerf = {} });
    try assert_eq(rust.cmd_set_integration, Command{ .SetIntegration = .{
        .name = "test-integration",
        .version = "1.0.0",
    } });
    try assert_eq(rust.cmd_err, Command{ .Err = {} });

    // AddMarker commands
    try assert_eq(rust.cmd_add_marker_sample_start, Command{ .AddMarker = .{
        .pid = 12345,
        .marker = shared.MarkerType{ .SampleStart = 1000 },
    } });
    try assert_eq(rust.cmd_add_marker_sample_end, Command{ .AddMarker = .{
        .pid = 12345,
        .marker = shared.MarkerType{ .SampleEnd = 2000 },
    } });
    try assert_eq(rust.cmd_add_marker_benchmark_start, Command{ .AddMarker = .{
        .pid = 12345,
        .marker = shared.MarkerType{ .BenchmarkStart = 3000 },
    } });
    try assert_eq(rust.cmd_add_marker_benchmark_end, Command{ .AddMarker = .{
        .pid = 12345,
        .marker = shared.MarkerType{ .BenchmarkEnd = 4000 },
    } });

    // SetVersion command
    try assert_eq(rust.cmd_set_version, Command{ .SetVersion = 1 });

    // GetIntegrationMode command
    try assert_eq(rust.cmd_get_runner_mode, Command{ .GetIntegrationMode = {} });

    // IntegrationModeResponse commands
    try assert_eq(rust.cmd_runner_mode_perf, Command{ .IntegrationModeResponse = .Perf });
    try assert_eq(rust.cmd_runner_mode_simulation, Command{ .IntegrationModeResponse = .Simulation });
    try assert_eq(rust.cmd_runner_mode_analysis, Command{ .IntegrationModeResponse = .Analysis });
}
