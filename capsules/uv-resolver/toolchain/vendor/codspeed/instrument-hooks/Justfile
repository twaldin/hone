clean:
    rm -rf zig-out/
    rm -rf .zig-cache
    rm -rf dist/core.c
    rm -rf example/cmake-build

build:
    # Use a fixed traversal seed for reproducible transpilation output
    zig build --seed 12345

cmake-build-example:
    cd example && mkdir -p cmake-build && cd cmake-build && cmake .. && make -j

cmake-run-example: cmake-build-example
    ./example/cmake-build/example

bazel-build-example:
    cd example && bazelisk build //:example

bazel-run-example: bazel-build-example
    cd example && bazelisk run //:example

release: build
    test -f ./zig-out/lib/zig.h || cp "$(zig env | jq -r .lib_dir)/zig.h" ./includes/zig.h
    mkdir -p dist/
    python3 scripts/release.py

test:
    zig build test --summary all

test-valgrind:
    #!/usr/bin/env bash
    rm -f /tmp/runner*.fifo

    export CFLAGS="-Wno-error=format -Wno-error=format-security -Wno-format -Wno-format-security"

    clang $CFLAGS -O3 example/main.c dist/core.c -I includes/ -o clang-main && ./clang-main
    valgrind ./clang-main

    gcc $CFLAGS -O3 example/main.c dist/core.c -I includes/ -o gcc-main && ./gcc-main
    valgrind ./gcc-main

    rm -rf clang-main gcc-main

fmt:
    zig fmt src
