load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_library")

config_setting(
    name = "windows",
    constraint_values = ["@platforms//os:windows"],
)

# Instrument-hooks library with warning suppressions
cc_library(
    name = "instrument_hooks",
    srcs = ["instrument-hooks/dist/core.c"],
    hdrs = glob(["instrument-hooks/includes/*.h"]),
    includes = ["instrument-hooks/includes"],
    copts = select({
        ":windows": [
            "/wd4101",  # unreferenced local variable (equivalent to -Wno-unused-variable)
            "/wd4189",  # local variable is initialized but not referenced (equivalent to -Wno-unused-but-set-variable)
            "/wd4100",  # unreferenced formal parameter (equivalent to -Wno-unused-parameter)
            "/wd4245",  # signed/unsigned mismatch
            "/wd4132",  # const object should be initialized
            "/wd4146",  # unary minus operator applied to unsigned type
        ],
        "//conditions:default": [
            "-Wno-maybe-uninitialized",
            "-Wno-unused-variable",
            "-Wno-unused-parameter",
            "-Wno-unused-but-set-variable",
            "-Wno-type-limits",
        ],
    }),
    visibility = ["//visibility:public"],
)

cc_binary(
    name = "example",
    srcs = ["main.c"],
    deps = [":instrument_hooks"],
    copts = select({
        ":windows": ["/W4", "/WX"],
        "//conditions:default": ["-Wall", "-Wextra", "-Werror"],
    }),
)
