use std::{
    fmt::{self, Debug, Formatter},
    io::Read,
};

/// The error reported when trying to read more bytes than were available.
#[derive(Debug, Copy, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Expected at least {expected} bytes, but only {actual} bytes were found")]
pub(crate) struct InvalidSize {
    pub(crate) expected: usize,
    pub(crate) actual: usize,
}

/// A cheaply copyable, incremental byte reader.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Scanner<'buf> {
    rest: &'buf [u8],
    current_position: usize,
}

impl<'buf> Scanner<'buf> {
    pub(crate) fn new(bytes: &'buf [u8]) -> Self {
        Scanner {
            rest: bytes,
            current_position: 0,
        }
    }

    pub(crate) fn with_current_position(self, current_position: usize) -> Self {
        Scanner {
            current_position,
            ..self
        }
    }

    pub(crate) fn current_position(&self) -> usize {
        self.current_position
    }

    /// The un-scanned bytes.
    pub(crate) fn rest(&self) -> &'buf [u8] {
        self.rest
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.rest().is_empty()
    }

    /// Take a certain number of bytes from the start of the buffer, advancing
    /// the [`Scanner`] if the read was successful.
    pub(crate) fn take(&mut self, len: usize) -> Result<&'buf [u8], InvalidSize> {
        if self.rest.len() < len {
            Err(InvalidSize {
                expected: self.current_position + len,
                actual: self.current_position + self.rest.len(),
            })
        } else {
            let (bytes, rest) = self.rest.split_at(len);
            self.rest = rest;
            self.current_position += len;

            Ok(bytes)
        }
    }

    /// Split off the next `len` bytes into their own [`Scanner`], advancing
    /// the current [`Scanner`] past the bytes.
    pub(crate) fn split_off(&mut self, len: usize) -> Result<Self, InvalidSize> {
        let current_position = self.current_position();

        if len > self.rest().len() {
            return Err(InvalidSize {
                expected: current_position + len,
                actual: current_position + self.rest().len(),
            });
        }

        let (head, tail) = self.rest().split_at(len);

        *self = Scanner {
            rest: tail,
            current_position: current_position + len,
        };
        Ok(Scanner {
            rest: head,
            current_position,
        })
    }

    /// Get a copy of this [`Scanner`] which can only read up to `len` bytes.
    pub(crate) fn truncated(&self, len: usize) -> Result<Self, InvalidSize> {
        self.clone().split_off(len)
    }

    /// Read an array from the buffer by value.
    pub(crate) fn read<const LEN: usize>(&mut self) -> Result<[u8; LEN], InvalidSize>
    where
        [u8; LEN]: Copy,
    {
        self.read_ref().copied()
    }

    pub(crate) fn read_usize(&mut self) -> Result<usize, InvalidSize> {
        let bytes = self.read()?;

        match u64::from_le_bytes(bytes).try_into() {
            Ok(v) => Ok(v),
            Err(_) => unreachable!(),
        }
    }

    /// Read an array from the buffer by reference.
    pub(crate) fn read_ref<const LEN: usize>(&mut self) -> Result<&'buf [u8; LEN], InvalidSize> {
        let bytes = self.take(LEN)?;

        match <&[u8; LEN]>::try_from(bytes) {
            Ok(b) => Ok(b),
            Err(_) => unreachable!("Length is guaranteed by the take() method"),
        }
    }
}

impl Read for Scanner<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let rest = self.rest();

        let bytes_read = std::cmp::min(rest.len(), buf.len());
        let buffer = match self.take(bytes_read) {
            Ok(b) => b,
            Err(_) => unreachable!("std::cmp::min() already did the bounds checking"),
        };

        buf.copy_from_slice(buffer);
        Ok(bytes_read)
    }
}

impl Debug for Scanner<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        let Scanner {
            rest,
            current_position,
        } = self;

        f.debug_struct("Scanner")
            .field(
                "rest",
                &TruncatedBuffer {
                    buffer: rest,
                    length: 32,
                },
            )
            .field("current_position", current_position)
            .finish()
    }
}

struct TruncatedBuffer<'a> {
    buffer: &'a [u8],
    length: usize,
}

impl Debug for TruncatedBuffer<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        let TruncatedBuffer { buffer, length } = *self;

        match buffer.get(..length) {
            Some(truncated) => write!(f, "{truncated:?}..."),
            None => write!(f, "{buffer:?}"),
        }
    }
}
