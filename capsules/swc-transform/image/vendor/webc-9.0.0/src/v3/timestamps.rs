use std::time::SystemTime;

use bytes::BytesMut;

use crate::since_epoch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Timestamps {
    pub modified: SystemTime,
}

impl Default for Timestamps {
    fn default() -> Self {
        Self {
            modified: SystemTime::UNIX_EPOCH,
        }
    }
}

impl Timestamps {
    pub fn from_metadata(metadata: &std::fs::Metadata) -> Result<Timestamps, std::io::Error> {
        let modified = metadata.modified()?;

        Ok(Timestamps { modified })
    }

    pub fn write_to(&self, buf: &mut BytesMut) -> Result<(), std::io::Error> {
        let modified = since_epoch(self.modified)?;

        buf.extend(0u64.to_le_bytes()); // accessed
        buf.extend(modified.as_secs().to_le_bytes()); // modified
        buf.extend(0u64.to_le_bytes()); // created

        Ok(())
    }
}

impl From<Timestamps> for crate::Timestamps {
    fn from(value: Timestamps) -> Self {
        let modified = since_epoch(value.modified).unwrap();

        crate::Timestamps {
            modified: modified.as_nanos() as u64,
        }
    }
}
