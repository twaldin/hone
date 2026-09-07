//! Read-only view over an in-memory ELF image, providing typed access to
//! program headers, the dynamic section, notes, and version definitions.
//!
//! ELF structure navigated by this module:
//!
//!   dl_phdr_info (one per loaded object, from dl_iterate_phdr)
//!   ├── dlpi_addr              base load address (ASLR bias)
//!   ├── dlpi_name              filesystem path
//!   └── dlpi_phdr[]            program headers
//!       │
//!       ├── PT_DYNAMIC         → array of Elf64_Dyn entries
//!       │   ├── DT_STRTAB     → string table base (relocated, absolute address)
//!       │   ├── DT_SONAME     → strtab offset → canonical library name
//!       │   └── DT_VERDEF     → file-relative offset → linked list of Verdef
//!       │       └── Verdef → Verdaux.name → strtab offset → version string
//!       │                                   (e.g. "GLIBC_2.39")
//!       │
//!       └── PT_NOTE            → flat byte array
//!           └── NT_GNU_BUILD_ID → 20-byte SHA-1 build fingerprint
//!
//! Note on relocation:
//!   DT_STRTAB is relocated to an absolute address by the dynamic linker.
//!   DT_VERDEF is NOT relocated — it remains a file-relative offset and
//!   must be added to the base load address via ptr().

const std = @import("std");
const builtin = @import("builtin");
const elf = std.elf;
const native_endian = builtin.cpu.arch.endian();

base_addr: usize,
phdrs: []const elf.Phdr,

const Self = @This();

/// Create a view for a library loaded at runtime (from dl_iterate_phdr).
pub fn init(base_addr: usize, phdr_ptr: [*]const elf.Phdr, phnum: u16) Self {
    return .{
        .base_addr = base_addr,
        .phdrs = @as([*]const elf.Phdr, @ptrCast(phdr_ptr))[0..phnum],
    };
}

/// Resolve a load-relative virtual address to a typed pointer.
pub fn ptr(self: Self, comptime T: type, vaddr: usize) *const T {
    return @ptrFromInt(self.base_addr + vaddr);
}

/// Resolve a load-relative virtual address to a byte slice.
pub fn slice(self: Self, vaddr: usize, len: usize) []const u8 {
    return @as([*]const u8, @ptrFromInt(self.base_addr + vaddr))[0..len];
}

/// Find the first program header with the given type.
pub fn findPhdr(self: Self, p_type: u32) ?elf.Phdr {
    for (self.phdrs) |phdr| {
        if (phdr.p_type == p_type) return phdr;
    }
    return null;
}

/// Get the dynamic entries array from PT_DYNAMIC.
pub fn dynamicEntries(self: Self) ?[]const elf.Dyn {
    const phdr = self.findPhdr(elf.PT_DYNAMIC) orelse return null;
    const dyn_ptr: [*]const elf.Dyn = @ptrFromInt(self.base_addr + phdr.p_vaddr);
    return dyn_ptr[0..@divExact(phdr.p_memsz, @sizeOf(elf.Dyn))];
}

/// Find the value of a dynamic entry by tag. Stops at DT_NULL.
pub fn dynVal(entries: []const elf.Dyn, tag: i64) ?usize {
    for (entries) |entry| {
        if (entry.d_tag == tag) return entry.d_val;
        if (entry.d_tag == elf.DT_NULL) break;
    }
    return null;
}

/// Get the dynamic string table pointer (DT_STRTAB, already relocated at runtime).
pub fn strtab(entries: []const elf.Dyn) ?[*]const u8 {
    const addr = dynVal(entries, elf.DT_STRTAB) orelse return null;
    return @ptrFromInt(addr);
}

/// Read a null-terminated string from a string table at the given offset.
pub fn strFromTable(table: [*]const u8, offset: usize) []const u8 {
    return std.mem.span(@as([*:0]const u8, @ptrFromInt(@intFromPtr(table) + offset)));
}

/// Extract the SONAME from the dynamic section.
pub fn soname(entries: []const elf.Dyn, table: [*]const u8) ?[]const u8 {
    const offset = dynVal(entries, elf.DT_SONAME) orelse return null;
    return strFromTable(table, offset);
}

/// Extract the GNU Build ID from PT_NOTE as raw bytes.
/// Note layout: [namesz:u32][descsz:u32][type:u32]["GNU\0"][build_id_bytes...]
pub fn buildId(self: Self) ?[]const u8 {
    for (self.phdrs) |phdr| {
        if (phdr.p_type != elf.PT_NOTE) continue;

        const note = self.slice(phdr.p_vaddr, phdr.p_memsz);
        if (note.len < 16) continue;

        const name_size = std.mem.readInt(u32, note[0..4], native_endian);
        if (name_size != 4) continue;
        const desc_size = std.mem.readInt(u32, note[4..8], native_endian);
        const note_type = std.mem.readInt(u32, note[8..12], native_endian);
        if (note_type != elf.NT_GNU_BUILD_ID) continue;
        if (!std.mem.eql(u8, note[12..16], "GNU\x00")) continue;

        return note[16..][0..desc_size];
    }
    return null;
}

// --- Tests ---
//
// All tests use libtest_fixture.so — a tiny shared library built by build.zig
// with a known SONAME, hardcoded build ID, and version definitions (TESTLIB_1.0, TESTLIB_2.0).
// It is linked into the test binary so it appears in dl_iterate_phdr at runtime.
//
// Expected values from: readelf -d -n -V libtest_fixture.so
//   SONAME:  libtest_fixture.so
//   Build ID: 0xdeadbeef (4 bytes)
//   Verdef:  3 entries — "libtest_fixture.so" (BASE), "TESTLIB_1.0", "TESTLIB_2.0"

const is_linux = builtin.os.tag == .linux;

const TestFixture = struct {
    view: Self,
};

/// Use dl_iterate_phdr to find the test fixture library.
/// Only available on Linux where dl_phdr_info exposes ELF fields.
fn testFixture() ?TestFixture {
    if (comptime !is_linux) return null;

    const Ctx = struct { result: ?TestFixture };
    var ctx = Ctx{ .result = null };

    _ = std.c.dl_iterate_phdr(&struct {
        fn callback(info: *std.c.dl_phdr_info, _: usize, data: ?*anyopaque) callconv(.c) c_int {
            const c: *Ctx = @ptrCast(@alignCast(data));
            const name = std.mem.span(info.name orelse return 0);
            if (std.mem.indexOf(u8, name, "test_fixture") != null) {
                c.result = .{
                    .view = Self.init(info.addr, info.phdr, info.phnum),
                };
                return 1;
            }
            return 0;
        }
    }.callback, @ptrCast(&ctx));

    return ctx.result;
}

// -- findPhdr --

test "findPhdr returns PT_DYNAMIC" {
    const fixture = testFixture() orelse return error.SkipZigTest;
    const phdr = fixture.view.findPhdr(elf.PT_DYNAMIC);
    try std.testing.expect(phdr != null);
    try std.testing.expectEqual(elf.PT_DYNAMIC, phdr.?.p_type);
}

test "findPhdr returns PT_NOTE" {
    const fixture = testFixture() orelse return error.SkipZigTest;
    const phdr = fixture.view.findPhdr(elf.PT_NOTE);
    try std.testing.expect(phdr != null);
    try std.testing.expectEqual(elf.PT_NOTE, phdr.?.p_type);
}

test "findPhdr returns null for absent type" {
    const fixture = testFixture() orelse return error.SkipZigTest;
    try std.testing.expectEqual(null, fixture.view.findPhdr(elf.PT_SHLIB));
}

// -- dynamicEntries --

test "dynamicEntries returns non-empty" {
    const fixture = testFixture() orelse return error.SkipZigTest;
    const entries = fixture.view.dynamicEntries();
    try std.testing.expect(entries != null);
    try std.testing.expect(entries.?.len > 0);
}

// -- dynVal --

test "dynVal finds DT_STRTAB" {
    const fixture = testFixture() orelse return error.SkipZigTest;
    const entries = fixture.view.dynamicEntries() orelse return error.NoDynamic;
    try std.testing.expect(dynVal(entries, elf.DT_STRTAB) != null);
}

test "dynVal returns null for absent tag" {
    const fixture = testFixture() orelse return error.SkipZigTest;
    const entries = fixture.view.dynamicEntries() orelse return error.NoDynamic;
    try std.testing.expectEqual(null, dynVal(entries, 0x7ffffffd));
}

// -- soname --

test "soname is libtest_fixture.so" {
    const fixture = testFixture() orelse return error.SkipZigTest;
    const entries = fixture.view.dynamicEntries() orelse return error.NoDynamic;
    const table = Self.strtab(entries) orelse return error.NoStrtab;
    const name = Self.soname(entries, table);
    try std.testing.expect(name != null);
    try std.testing.expectEqualStrings("libtest_fixture.so", name.?);
}

// -- buildId --

test "buildId returns hardcoded value" {
    const fixture = testFixture() orelse return error.SkipZigTest;
    const id = fixture.view.buildId() orelse return error.NoBuildId;

    // The test fixture is built with a fixed build ID: 0xdeadbeef (4 bytes)
    try std.testing.expectEqual(@as(usize, 4), id.len);
    try std.testing.expectEqualSlices(u8, "\xde\xad\xbe\xef", id);
}
