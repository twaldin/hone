//! # Basic usage
//!
//! ```
//! use diskus::DiskUsage;
//!
//! let result = DiskUsage::new(&["."]).count();
//! let size_in_bytes = result.ignore_errors().size_in_bytes();
//! ```

mod filesize;
mod unique_id;
pub mod walk;

pub use crate::filesize::CountType;
pub use crate::walk::{Directories, DiskUsage, DiskUsageResult, Error};
