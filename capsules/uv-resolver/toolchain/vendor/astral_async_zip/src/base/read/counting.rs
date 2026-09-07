use std::io;
use std::io::Read;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures_lite::io::AsyncBufRead;
use futures_lite::io::AsyncRead;

/// A wrapper around a reader that counts the number of bytes read.
pub struct Counting<R> {
    inner: R,
    bytes: u64,
}

impl<R> Counting<R> {
    /// Creates a new [`Counting`] reader that wraps the provided inner reader.
    pub fn new(inner: R) -> Self {
        Self { inner, bytes: 0 }
    }

    /// Returns the number of bytes read so far.
    pub fn bytes_read(&self) -> u64 {
        self.bytes
    }

    /// Consumes the [`Counting`] reader and returns the inner reader.
    pub fn into_inner(self) -> R {
        self.inner
    }
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for Counting<R> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();

        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(n)) => {
                this.bytes += n as u64;
                Poll::Ready(Ok(n))
            }
            other => other,
        }
    }
}

impl<R: AsyncBufRead + Unpin> AsyncBufRead for Counting<R> {
    fn poll_fill_buf(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<&[u8]>> {
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_fill_buf(cx)
    }

    fn consume(self: Pin<&mut Self>, amt: usize) {
        let this = self.get_mut();
        this.bytes += amt as u64;
        Pin::new(&mut this.inner).consume(amt);
    }
}
