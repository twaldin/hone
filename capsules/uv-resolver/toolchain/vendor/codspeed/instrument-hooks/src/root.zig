test "run all tests" {
    _ = @import("tests/deserialize_rust/rust_deser.zig");
    _ = @import("bincode.zig");
    _ = @import("environment/root.zig");
    _ = @import("environment/linked_libraries/root.zig");
    _ = @import("environment/linked_libraries/elf_view.zig");
    _ = @import("fifo/root.zig");
    _ = @import("c.zig");
    _ = @import("utils.zig");
}
