<!-- cargo-sync-rdme title [[ -->
# quick-junit
<!-- cargo-sync-rdme ]] -->
<!-- cargo-sync-rdme badge [[ -->
![License: Apache-2.0 OR MIT](https://img.shields.io/crates/l/quick-junit.svg?)
[![crates.io](https://img.shields.io/crates/v/quick-junit.svg?logo=rust)](https://crates.io/crates/quick-junit)
[![docs.rs](https://img.shields.io/docsrs/quick-junit.svg?logo=docs.rs)](https://docs.rs/quick-junit)
[![Rust: ^1.79.0](https://img.shields.io/badge/rust-^1.79.0-93450a.svg?logo=rust)](https://doc.rust-lang.org/cargo/reference/manifest.html#the-rust-version-field)
<!-- cargo-sync-rdme ]] -->
<!-- cargo-sync-rdme rustdoc [[ -->
`quick-junit` is a JUnit/XUnit XML data model and serializer for Rust. This crate allows users
to create a JUnit report as an XML file. JUnit XML files are widely supported by test tooling.

This crate is built to serve the needs of [cargo-nextest](https://nexte.st).

## Overview

The root element of a JUnit report is a [`Report`](https://docs.rs/quick-junit/0.6.0/quick_junit/report/struct.Report.html). A [`Report`](https://docs.rs/quick-junit/0.6.0/quick_junit/report/struct.Report.html) consists of one or more
[`TestSuite`](https://docs.rs/quick-junit/0.6.0/quick_junit/report/struct.TestSuite.html) instances. A [`TestSuite`](https://docs.rs/quick-junit/0.6.0/quick_junit/report/struct.TestSuite.html) instance consists of one or more [`TestCase`](https://docs.rs/quick-junit/0.6.0/quick_junit/report/struct.TestCase.html)s.

The status (success, failure, error, or skipped) of a [`TestCase`](https://docs.rs/quick-junit/0.6.0/quick_junit/report/struct.TestCase.html) is represented by
[`TestCaseStatus`](https://docs.rs/quick-junit/0.6.0/quick_junit/report/enum.TestCaseStatus.html).

## Features

* ✅ Serializing JUnit/XUnit to the [Jenkins format](https://llg.cubic.org/docs/junit/).
* ✅ Deserializing JUnit/XUnit XML back to Rust data structures
* ✅ Including test reruns using [`TestRerun`](https://docs.rs/quick-junit/0.6.0/quick_junit/report/struct.TestRerun.html)
* ✅ Including flaky tests
* ✅ Including standard output and error
  * ✅ Filtering out [invalid XML
    characters](https://en.wikipedia.org/wiki/Valid_characters_in_XML) (eg ANSI escape codes)
    from the output
* ✅ Automatically keeping track of success, failure and error counts
* ✅ Arbitrary properties and extra attributes

## Examples

````rust
use quick_junit::*;

let mut report = Report::new("my-test-run");
let mut test_suite = TestSuite::new("my-test-suite");
let success_case = TestCase::new("success-case", TestCaseStatus::success());
let failure_case = TestCase::new("failure-case", TestCaseStatus::non_success(NonSuccessKind::Failure));
test_suite.add_test_cases([success_case, failure_case]);
report.add_test_suite(test_suite);

const EXPECTED_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="my-test-run" tests="2" failures="1" errors="0">
    <testsuite name="my-test-suite" tests="2" disabled="0" errors="0" failures="1">
        <testcase name="success-case">
        </testcase>
        <testcase name="failure-case">
            <failure/>
        </testcase>
    </testsuite>
</testsuites>
"#;

assert_eq!(report.to_string().unwrap(), EXPECTED_XML);
````

For a more comprehensive example, including reruns and flaky tests, see
[`fixture_tests.rs`](https://github.com/nextest-rs/quick-junit/blob/main/crates/quick-junit-tests/tests/integration/fixture_tests.rs).

## Optional features

* **proptest**: Generate `Arbitrary` instances for use with proptest. *Not enabled by default.*

## Minimum supported Rust version (MSRV)

The minimum supported Rust version is **Rust 1.79.** At any time, Rust versions from at least
the last 6 months will be supported.

While this crate is a pre-release (0.x.x) it may have its MSRV bumped in a patch release. Once a
crate has reached 1.x, any MSRV bump will be accompanied with a new minor version.

## Alternatives

* [**junit-report**](https://crates.io/crates/junit-report): Older, more mature project. Doesn’t
  appear to support flaky tests or arbitrary properties as of version 0.8.3.
<!-- cargo-sync-rdme ]] -->

## Contributing

See the [CONTRIBUTING](../../CONTRIBUTING.md) file for how to help out.

## License

This project is available under the terms of either the [Apache 2.0 license](../../LICENSE-APACHE) or
the [MIT license](../../LICENSE-MIT).
