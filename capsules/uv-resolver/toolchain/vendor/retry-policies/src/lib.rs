//! A collection of plug-and-play retry policies.
pub mod policies;
mod retry_policy;

pub use retry_policy::{Jitter, RetryDecision, RetryPolicy};
