cmake_minimum_required(VERSION 3.16)
project(instrument-hooks-example C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Define the instrument_hooks library
add_library(
    instrument_hooks
    STATIC
    ${CMAKE_CURRENT_SOURCE_DIR}/instrument-hooks/dist/core.c
)

target_include_directories(
    instrument_hooks
    PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/instrument-hooks/includes>
    $<INSTALL_INTERFACE:includes>
)

# Suppress warnings for the instrument_hooks library
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(
        instrument_hooks
        PRIVATE
        -Wno-maybe-uninitialized
        -Wno-unused-variable
        -Wno-unused-parameter
        -Wno-unused-but-set-variable
        -Wno-type-limits
    )
elseif(CMAKE_CXX_COMPILER_ID STREQUAL "MSVC")
    target_compile_options(
        instrument_hooks
        PRIVATE
        /wd4101  # unreferenced local variable (equivalent to -Wno-unused-variable)
        /wd4189  # local variable is initialized but not referenced (equivalent to -Wno-unused-but-set-variable)
        /wd4100  # unreferenced formal parameter (equivalent to -Wno-unused-parameter)
        /wd4245  # signed/unsigned mismatch
        /wd4132  # const object should be initialized
        /wd4146  # unary minus operator applied to unsigned type
    )
endif()

# Example executable
add_executable(example main.c)
target_link_libraries(example instrument_hooks)

# Treat warnings as errors for the example
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(example PRIVATE -Wall -Wextra -Werror)
elseif(CMAKE_C_COMPILER_ID STREQUAL "MSVC")
    target_compile_options(example PRIVATE /W4 /WX)
endif()
