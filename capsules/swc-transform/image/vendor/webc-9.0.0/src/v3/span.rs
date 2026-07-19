use std::ops::Index;

/// The location of something within a larger buffer.
#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct Span {
    /// The start of an item, relative to the start of the file.
    pub start: usize,
    /// The number of bytes in this item.
    pub len: usize,
}

impl Span {
    /// Create a new [`Span`].
    pub const fn new(start: usize, len: usize) -> Self {
        Self { start, len }
    }

    /// Get the offset one past the end.
    pub const fn end(self) -> usize {
        self.start + self.len
    }

    pub const fn with_offset(self, delta: usize) -> Self {
        Span::new(self.start + delta, self.len)
    }
}

impl Index<Span> for [u8] {
    type Output = [u8];

    #[track_caller]
    fn index(&self, index: Span) -> &Self::Output {
        &self[index.start..index.end()]
    }
}
