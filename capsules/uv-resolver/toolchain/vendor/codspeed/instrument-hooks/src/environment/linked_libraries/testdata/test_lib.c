// Minimal shared library used as a test fixture for ElfView tests.
// Built by build.zig as a .so with a known SONAME, build ID, and version
// definitions. Version script: test_lib.ver defines TESTLIB_1.0 and
// TESTLIB_2.0.

int test_lib_add(int a, int b) { return a + b; }
int test_lib_mul(int a, int b) { return a * b; }
