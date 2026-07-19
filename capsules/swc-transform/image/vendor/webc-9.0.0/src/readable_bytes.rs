use std::fmt::{self, Debug, Display, Formatter};

/// Print a human-friendly version of a byte string.
#[allow(dead_code)]
pub(crate) fn readable_bytes(bytes: &[u8]) -> impl Display + Debug + Copy + '_ {
    ReadableBytes { bytes, limit: 64 }
}

#[derive(Copy, Clone)]
pub(crate) struct ReadableBytes<'a> {
    bytes: &'a [u8],
    limit: usize,
}

impl ReadableBytes<'_> {
    fn write(&self, f: &mut Formatter<'_>) -> fmt::Result {
        if let Ok(s) = std::str::from_utf8(self.bytes) {
            f.write_str("\"")?;
            for (i, c) in s.chars().enumerate() {
                if i >= self.limit {
                    f.write_str("...")?;
                    break;
                }
                for c in c.escape_debug() {
                    Display::fmt(&c, f)?;
                }
            }
            f.write_str("\"")?;
            return Ok(());
        }

        // otherwise, fall back to escaped ascii
        let len = std::cmp::min(self.bytes.len(), self.limit);

        f.write_str("b\"")?;
        for &byte in &self.bytes[..len] {
            for c in std::ascii::escape_default(byte) {
                Display::fmt(&c, f)?;
            }
        }
        if len == self.limit {
            f.write_str("...")?;
        }
        f.write_str("\"")?;

        Ok(())
    }
}

impl Display for ReadableBytes<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        self.write(f)
    }
}

impl Debug for ReadableBytes<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        self.write(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode() {
        let src = "Hello, Unicode! ✓";

        let got = readable_bytes(src.as_bytes()).to_string();

        assert_eq!(got, "\"Hello, Unicode! \u{2713}\"");
    }

    #[test]
    fn binary() {
        let src = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

        let got = readable_bytes(&src).to_string();

        assert_eq!(got, "\"\\0asm\\u{1}\\0\\0\\0\"");
    }

    #[test]
    fn limit_the_length() {
        let src = [b'A'; 256];

        let got = readable_bytes(&src).to_string();

        assert_eq!(got, format!("\"{}...\"", "A".repeat(64)));
    }
}
