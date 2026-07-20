//! Known qualifier types for [maven].
//!
//! [maven]: https://github.com/package-url/purl-spec/blob/master/PURL-TYPES.rst#maven

use super::str_ref_qualifier;

str_ref_qualifier!(Classifier, "classifier", "classifier");
str_ref_qualifier!(Type, "type", "type");
