#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CountType {
    /// Count the disk usage of files (the actual space used on disk).
    #[default]
    DiskUsage,
    /// Count the apparent size of files (the number of bytes reported by `stat`).
    ApparentSize,
}

impl CountType {
    #[cfg(not(windows))]
    pub fn size(self, metadata: &std::fs::Metadata) -> u64 {
        use std::os::unix::fs::MetadataExt;

        match self {
            CountType::ApparentSize => metadata.len(),
            // block size is always 512 byte, see stat(2) manpage
            CountType::DiskUsage => metadata.blocks() * 512,
        }
    }

    #[cfg(windows)]
    pub fn size(self, metadata: &std::fs::Metadata) -> u64 {
        metadata.len()
    }
}
