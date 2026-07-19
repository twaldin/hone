use std::time::{Duration, SystemTime};

pub(crate) fn since_epoch(systemtime: SystemTime) -> Result<Duration, std::io::Error> {
    systemtime
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

#[derive(
    Default, Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize,
)]
/// Represents file or directory timestamps.
pub struct Timestamps {
    pub(crate) modified: u64,
}

impl Timestamps {
    /// Extracts timestamps from the metadata.
    pub fn from_metadata(metadata: &std::fs::Metadata) -> Result<Timestamps, std::io::Error> {
        let modified = metadata.modified()?;

        let modified = since_epoch(modified).unwrap();

        Ok(Timestamps {
            modified: modified.as_nanos() as u64,
        })
    }

    /// Create a timestamp from a `modified` time
    pub fn from_modified(modified: u64) -> Self {
        Self { modified }
    }

    /// timestamp of the last access time
    pub fn accessed(&self) -> u64 {
        0
    }

    /// timestamp of the latest modification time
    pub fn modified(&self) -> u64 {
        self.modified
    }

    /// timestamp of the creation time
    pub fn created(&self) -> u64 {
        0
    }
}
