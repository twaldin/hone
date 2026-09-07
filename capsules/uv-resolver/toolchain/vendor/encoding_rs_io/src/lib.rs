/*!
This crate provides streaming transcoding by implementing Rust's I/O traits
and delegating transcoding to the
[`encoding_rs`](https://crates.io/crates/encoding_rs)
crate.

Currently, this crate only provides a means of transcoding from a source
encoding (that is among the encodings supported by `encoding_rs`) to UTF-8 via
an implementation of `std::io::Read`, where errors are handled by replacing
invalid sequences with the Unicode replacement character. Future work may
provide additional implementations for `std::io::Write` and/or implementations
that make stronger guarantees about UTF-8 validity.

# Example

This example shows how to create a decoder that transcodes UTF-16LE (the
source) to UTF-8 (the destination).

```
extern crate encoding_rs;
extern crate encoding_rs_io;

use std::error::Error;
use std::io::Read;

use encoding_rs_io::DecodeReaderBytes;

# fn main() { example().unwrap(); }
fn example() -> Result<(), Box<Error>> {
    let source_data = &b"\xFF\xFEf\x00o\x00o\x00b\x00a\x00r\x00"[..];
    // N.B. `source_data` can be any arbitrary io::Read implementation.
    let mut decoder = DecodeReaderBytes::new(source_data);

    let mut dest = String::new();
    // decoder implements the io::Read trait, so it can easily be plugged
    // into any consumer expecting an arbitrary reader.
    decoder.read_to_string(&mut dest)?;
    assert_eq!(dest, "foobar");
    Ok(())
}
```

# Future work

Currently, this crate only provides a way to get _possibly valid_ UTF-8 from
some source encoding. There are other transformations that may be useful that
we could include in this crate. Namely:

* An encoder that accepts an arbitrary `std::io::Write` implementation and
  takes valid UTF-8 and transcodes it to a selected destination encoding. This
  encoder would implement `std::fmt::Write`.
* A decoder that accepts an arbitrary `std::fmt::Write` implementation and
  takes arbitrary bytes and transcodes them from a selected source
  encoding to valid UTF-8. This decoder would implement `std::io::Write`.
* An encoder that accepts an arbitrary `UnicodeRead` implementation and
  takes valid UTF-8 and transcodes it to a selected destination encoding.
  This encoder would implement `std::io::Read`.
* A decoder that accepts an arbitrary `std::io::Read` implementation and
  takes arbitrary bytes and transcodes them from a selected source encoding
  to valid UTF-8. This decoder would implement the `UnicodeRead` trait.

Where `UnicodeRead` is a hypothetical trait that does not yet exist. Its
definition might look something like this:

```ignore
trait UnicodeRead {
    fn read(&mut self, buf: &mut str) -> Result<usize>;
}
```

Interestingly, of the above transformations, none of them correspond to
`DecodeReaderBytes`. Namely, `DecodeReaderBytes` most closely corresponds to
the last option, but instead of guaranteeing valid UTF-8 by implementing a
trait like `UnicodeRead`, it instead implements `std::io::Read`, which pushes
UTF-8 handling on to the caller. However, it turns out that this particular
use case is important for operations like search, which can often be written
in a way that don't assume UTF-8 validity but still benefit from it.

It's not clear which of the above transformations is actually useful, but all
of them could theoretically exist. There is more discussion on this topic
here (and in particular, the above formulation was taken almost verbatim from
Simon Sapin's comments): https://github.com/hsivonen/encoding_rs/issues/8

It is also perhaps worth stating that this crate very much intends on
remaining coupled to `encoding_rs`, which helps restrict the scope, but may be
too biased toward Web oriented encoding to solve grander encoding challenges.
As such, it may very well be that this crate is actually a stepping stone to
something with a larger scope. But first, we must learn.
*/

extern crate encoding_rs;

use std::fmt;
use std::io::{self, Read};

use encoding_rs::{Decoder, Encoding, UTF_8};

use util::{BomPeeker, TinyTranscoder};

mod util;

/// A builder for constructing a byte oriented transcoder to UTF-8.
#[derive(Clone, Debug)]
pub struct DecodeReaderBytesBuilder {
    encoding: Option<&'static Encoding>,
    utf8_passthru: bool,
    bom_override: bool,
    strip_bom: bool,
    bom_sniffing: bool,
}

impl Default for DecodeReaderBytesBuilder {
    fn default() -> DecodeReaderBytesBuilder {
        DecodeReaderBytesBuilder::new()
    }
}

impl DecodeReaderBytesBuilder {
    /// Create a new decoder builder with a default configuration.
    ///
    /// By default, no explicit encoding is used, but if a UTF-8 or UTF-16
    /// BOM is detected, then an appropriate encoding is automatically
    /// detected and transcoding is performed (where invalid sequences map to
    /// the Unicode replacement codepoint).
    pub fn new() -> DecodeReaderBytesBuilder {
        DecodeReaderBytesBuilder {
            encoding: None,
            utf8_passthru: false,
            bom_override: false,
            strip_bom: false,
            bom_sniffing: true,
        }
    }

    /// Build a new decoder that wraps the given reader.
    pub fn build<R: io::Read>(&self, rdr: R) -> DecodeReaderBytes<R, Vec<u8>> {
        self.build_with_buffer(rdr, vec![0; 8 * (1 << 10)]).unwrap()
    }

    /// Build a new decoder that wraps the given reader and uses the given
    /// buffer internally for transcoding.
    ///
    /// This is useful for cases where it is advantageuous to amortize
    /// allocation. Namely, this method permits reusing a buffer for
    /// subsequent decoders.
    ///
    /// This returns an error if the buffer is smaller than 4 bytes (which is
    /// too small to hold maximum size of a single UTF-8 encoded codepoint).
    pub fn build_with_buffer<R: io::Read, B: AsMut<[u8]>>(
        &self,
        rdr: R,
        mut buffer: B,
    ) -> io::Result<DecodeReaderBytes<R, B>> {
        if buffer.as_mut().len() < 4 {
            let msg = format!(
                "DecodeReaderBytesBuilder: buffer of size {} is too small",
                buffer.as_mut().len(),
            );
            return Err(io::Error::new(io::ErrorKind::Other, msg));
        }
        let encoding =
            self.encoding.map(|enc| enc.new_decoder_with_bom_removal());

        // No need to do BOM detection if we opt out of it or have an explicit
        // encoding.
        let has_detected =
            !self.bom_sniffing || (!self.bom_override && encoding.is_some());

        let peeker = if self.strip_bom {
            BomPeeker::without_bom(rdr)
        } else {
            BomPeeker::with_bom(rdr)
        };
        Ok(DecodeReaderBytes {
            rdr: peeker,
            decoder: encoding,
            tiny: TinyTranscoder::new(),
            utf8_passthru: self.utf8_passthru,
            buf: buffer,
            buflen: 0,
            pos: 0,
            has_detected: has_detected,
            exhausted: false,
        })
    }

    /// Set an explicit encoding to be used by this decoder.
    ///
    /// When an explicit encoding is set, BOM sniffing is disabled and the
    /// encoding provided will be used unconditionally. Errors in the encoded
    /// bytes are replaced by the Unicode replacement codepoint.
    ///
    /// By default, no explicit encoding is set.
    pub fn encoding(
        &mut self,
        encoding: Option<&'static Encoding>,
    ) -> &mut DecodeReaderBytesBuilder {
        self.encoding = encoding;
        self
    }

    /// Enable UTF-8 passthru, even when a UTF-8 BOM is observed.
    ///
    /// When an explicit encoding is not set (thereby invoking automatic
    /// encoding detection via BOM sniffing), then a UTF-8 BOM will cause
    /// UTF-8 transcoding to occur. In particular, if the source contains
    /// invalid UTF-8 sequences, then they are replaced with the Unicode
    /// replacement codepoint.
    ///
    /// This transcoding may not be desirable. For example, the caller may
    /// already have its own UTF-8 handling where invalid UTF-8 is
    /// appropriately handled, in which case, doing an extra transcoding
    /// step is extra and unnecessary work. Enabling this option will prevent
    /// that extra transcoding step from occurring. In this case, the bytes
    /// emitted by the reader are passed through unchanged (including the BOM)
    /// and the caller will be responsible for handling any invalid UTF-8.
    ///
    /// # Example
    ///
    /// This example demonstrates the effect of enabling this option on data
    /// that includes a UTF-8 BOM but also, interestingly enough, subsequently
    /// includes invalid UTF-8.
    ///
    /// ```
    /// extern crate encoding_rs;
    /// extern crate encoding_rs_io;
    ///
    /// use std::error::Error;
    /// use std::io::Read;
    ///
    /// use encoding_rs_io::DecodeReaderBytesBuilder;
    ///
    /// # fn main() { example().unwrap(); }
    /// fn example() -> Result<(), Box<Error>> {
    ///     let source_data = &b"\xEF\xBB\xBFfoo\xFFbar"[..];
    ///     let mut decoder = DecodeReaderBytesBuilder::new()
    ///         .utf8_passthru(true)
    ///         .build(source_data);
    ///
    ///     let mut dest = vec![];
    ///     decoder.read_to_end(&mut dest)?;
    ///     // Without the passthru option, you'd get "foo\u{FFFD}bar".
    ///     assert_eq!(dest, b"\xEF\xBB\xBFfoo\xFFbar");
    ///     Ok(())
    /// }
    /// ```
    pub fn utf8_passthru(
        &mut self,
        yes: bool,
    ) -> &mut DecodeReaderBytesBuilder {
        self.utf8_passthru = yes;
        self
    }

    /// Whether or not to always strip a BOM if one is found.
    ///
    /// When this is enabled, if a BOM is found at the beginning of a stream,
    /// then it is ignored. This applies even when `utf8_passthru` is enabled
    /// or if `bom_sniffing` is disabled.
    ///
    /// This is disabled by default.
    ///
    /// # Example
    ///
    /// This example shows how to remove the BOM if it's present even when
    /// `utf8_passthru` is enabled.
    ///
    /// ```
    /// extern crate encoding_rs;
    /// extern crate encoding_rs_io;
    ///
    /// use std::error::Error;
    /// use std::io::Read;
    ///
    /// use encoding_rs_io::DecodeReaderBytesBuilder;
    ///
    /// # fn main() { example().unwrap(); }
    /// fn example() -> Result<(), Box<Error>> {
    ///     let source_data = &b"\xEF\xBB\xBFfoo\xFFbar"[..];
    ///     let mut decoder = DecodeReaderBytesBuilder::new()
    ///         .utf8_passthru(true)
    ///         .strip_bom(true)
    ///         .build(source_data);
    ///
    ///     let mut dest = vec![];
    ///     decoder.read_to_end(&mut dest)?;
    ///     // If `strip_bom` wasn't enabled, then this would include the BOM.
    ///     assert_eq!(dest, b"foo\xFFbar");
    ///     Ok(())
    /// }
    /// ```
    pub fn strip_bom(&mut self, yes: bool) -> &mut DecodeReaderBytesBuilder {
        self.strip_bom = yes;
        self
    }

    /// Give the highest precedent to the BOM, if one is found.
    ///
    /// When this is enabled, and if a BOM is found, then the encoding
    /// indicated by that BOM is used even if an explicit encoding has been
    /// set via the `encoding` method.
    ///
    /// This does not override `utf8_passthru`.
    ///
    /// This is disabled by default.
    pub fn bom_override(
        &mut self,
        yes: bool,
    ) -> &mut DecodeReaderBytesBuilder {
        self.bom_override = yes;
        self
    }

    /// Enable BOM sniffing
    ///
    /// When this is enabled and an explicit encoding is not set, the decoder
    /// will try to detect the encoding with BOM.
    ///
    /// When this is disabled and an explicit encoding is not set, the decoder
    /// will treat the input as raw bytes. The bytes will be passed through
    /// unchanged, including any BOM that may be present.
    ///
    /// This is enabled by default.
    pub fn bom_sniffing(
        &mut self,
        yes: bool,
    ) -> &mut DecodeReaderBytesBuilder {
        self.bom_sniffing = yes;
        self
    }
}

/// An implementation of `io::Read` that transcodes to UTF-8 in a streaming
/// fashion.
///
/// The high level goal of this decoder is to provide access to byte streams
/// that are assumed to be UTF-8 unless an encoding is otherwise specified
/// (either via a BOM or via an explicit designation of an encoding).
///
/// When no explicit source encoding is specified (via
/// `DecodeReaderBytesBuilder`), the source encoding is determined by
/// inspecting the BOM from the stream read from `R`, if one exists. If a
/// UTF-16 BOM exists, then the source stream is transcoded to UTF-8 with
/// invalid UTF-16 sequences translated to the Unicode replacement character.
/// Similarly if a UTF-8 BOM is seen. In all other cases, the source of the
/// underlying reader is passed through unchanged _as if_ it were UTF-8.
///
/// Since this particular reader does not guarantee providing valid UTF-8 to
/// the caller, the caller must be prepared to handle invalid UTF-8 itself.
///
/// `R` is the type of the underlying reader and `B` is the type of an internal
/// buffer used to store the results of transcoding. Callers may elect to reuse
/// the internal buffer via the `DecodeReaderBytesBuilder::build_with_buffer`
/// constructor.
pub struct DecodeReaderBytes<R, B> {
    /// The underlying reader, wrapped in a peeker for reading a BOM if one
    /// exists.
    rdr: BomPeeker<R>,
    /// The underlying text decoder derived from the BOM or an explicitly
    /// specified encoding, if one exists.
    decoder: Option<Decoder>,
    /// A "tiny transcoder" for use when a caller provides a buffer that is
    /// too small to write at least one UTF-8 encoded codepoint to.
    tiny: TinyTranscoder,
    /// When enabled, if a UTF-8 BOM is observed, then the bytes are passed
    /// through from the underlying reader as-is instead of passing through
    /// the UTF-8 transcoder (which will replace invalid sequences with the
    /// REPLACEMENT CHARACTER).
    utf8_passthru: bool,
    /// The internal buffer to store transcoded bytes before they are read by
    /// callers.
    buf: B,
    /// The current position in `buf`. Subsequent reads start here.
    pos: usize,
    /// The number of transcoded bytes in `buf`. Subsequent reads end here.
    buflen: usize,
    /// Whether BOM detection has been performed yet or not.
    has_detected: bool,
    /// Whether the underlying reader has been exhausted or not.
    exhausted: bool,
}

impl<R: io::Read, B: AsMut<[u8]>> io::Read for DecodeReaderBytes<R, B> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.detect()?;
        if self.decoder.is_none() {
            self.rdr.read(buf)
        } else {
            self.transcode(buf)
        }
    }
}

impl<R: io::Read> DecodeReaderBytes<R, Vec<u8>> {
    /// Create a new transcoder that converts a source stream to valid UTF-8
    /// via BOM sniffing.
    ///
    /// To explicitly control the encoding, UTF-8 passthru or amortize
    /// allocation, use the
    /// [`DecodeReaderBytesBuilder`](struct.DecodeReaderBytesBuilder.html)
    /// constructor.
    ///
    /// When a BOM is found (which must correspond to UTF-8, UTF-16LE or
    /// UTF-16BE), then transcoding to UTF-8 is performed and any invalid
    /// sequences in the source data are seamlessly replaced by the Unicode
    /// replacement character.
    ///
    /// When no BOM is found (and no other encoding is specified via the
    /// builder), the underlying bytes are passed through as-is.
    pub fn new(rdr: R) -> DecodeReaderBytes<R, Vec<u8>> {
        DecodeReaderBytesBuilder::new().build(rdr)
    }
}

impl<R: io::Read, B: AsMut<[u8]>> DecodeReaderBytes<R, B> {
    /// Transcode the inner stream to UTF-8 in `buf`. This assumes that there
    /// is a decoder capable of transcoding the inner stream to UTF-8. This
    /// returns the number of bytes written to `buf`.
    ///
    /// When this function returns, exactly one of the following things will
    /// be true:
    ///
    /// 1. A non-zero number of bytes were written to `buf`.
    /// 2. The underlying reader reached EOF (or `buf` is empty).
    /// 3. An error is returned: the internal buffer ran out of room.
    /// 4. An I/O error occurred.
    fn transcode(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.exhausted || buf.is_empty() {
            return Ok(0);
        }
        let nwrite = self.tiny.read(buf)?;
        if nwrite > 0 {
            // We could technically mush on if the caller provided buffer is
            // big enough, but to keep things we simple, we satisfy the
            // contract and quit.
            return Ok(nwrite);
        }
        if self.pos >= self.buflen {
            self.fill()?;
        }
        if buf.len() < 4 {
            return self.tiny_transcode(buf);
        }
        loop {
            let (_, nin, nout, _) =
                self.decoder.as_mut().unwrap().decode_to_utf8(
                    &self.buf.as_mut()[self.pos..self.buflen],
                    buf,
                    false,
                );
            self.pos += nin;
            // If we've written at least one byte to the caller-provided
            // buffer, then our mission is complete.
            if nout > 0 {
                return Ok(nout);
            }
            // Otherwise, we know that our internal buffer has insufficient
            // data to transcode at least one char, so we attempt to refill it.
            self.fill()?;
            // ... but quit on EOF.
            if self.buflen == 0 {
                let (_, _, nout, _) = self
                    .decoder
                    .as_mut()
                    .unwrap()
                    .decode_to_utf8(&[], buf, true);
                return Ok(nout);
            }
        }
    }

    /// Like transcode, but deals with the case where the caller provided
    /// buffer is less than 4.
    fn tiny_transcode(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        assert!(buf.len() < 4, "have a small caller buffer");
        loop {
            let (nin, nout) = self.tiny.transcode(
                self.decoder.as_mut().unwrap(),
                &self.buf.as_mut()[self.pos..self.buflen],
                false,
            );
            self.pos += nin;
            if nout > 0 {
                // We've satisfied the contract of writing at least one byte,
                // so we're done. The tiny transcoder is guaranteed to yield
                // a non-zero number of bytes.
                return self.tiny.read(buf);
            }
            // Otherwise, we know that our internal buffer has insufficient
            // data to transcode at least one char, so we attempt to refill it.
            self.fill()?;
            // ... but quit on EOF.
            if self.buflen == 0 {
                self.tiny.transcode(self.decoder.as_mut().unwrap(), &[], true);
                return self.tiny.read(buf);
            }
        }
    }

    /// Peeks at the underlying reader to look for a BOM. If one exists, then
    /// an appropriate decoder is created corresponding to the detected BOM.
    fn detect(&mut self) -> io::Result<()> {
        if self.has_detected {
            return Ok(());
        }
        self.has_detected = true;
        let bom = self.rdr.peek_bom()?;
        if let Some(encoding) = bom.encoding() {
            // If we got a UTF-8 BOM, and the decoder was configured for
            // passing through UTF-8, then don't build a decoder at all.
            if encoding == UTF_8 && self.utf8_passthru {
                return Ok(());
            }
            self.decoder = Some(encoding.new_decoder_with_bom_removal());
        }
        Ok(())
    }

    /// Fill the internal buffer from the underlying reader.
    ///
    /// If there are unread bytes in the internal buffer, then we move them
    /// to the beginning of the internal buffer and fill the remainder.
    ///
    /// If the internal buffer is too small to read additional bytes, then an
    /// error is returned.
    fn fill(&mut self) -> io::Result<()> {
        if self.pos < self.buflen {
            // Despite my best efforts, I could not seem to actually exercise
            // this code path in tests. Namely, this code path occurs when the
            // decoder can't make any progress and also doesn't consume all of
            // the input. Since I'm not sure how to trigger that case, this
            // code path is actually untested!

            // We can assert this because we require that the caller provided
            // buffer be at least 4 bytes big.
            assert!(
                self.buflen < self.buf.as_mut().len(),
                "internal buffer should never be exhausted"
            );
            let buf = self.buf.as_mut();
            for (dst, src) in (self.pos..self.buflen).enumerate() {
                buf[dst] = buf[src];
            }
            self.buflen -= self.pos;
        } else {
            self.buflen = 0;
        }
        self.pos = 0;
        self.buflen += self.rdr.read(&mut self.buf.as_mut()[self.buflen..])?;
        if self.buflen == 0 {
            self.exhausted = true;
        }
        Ok(())
    }
}

impl<R: fmt::Debug, B: fmt::Debug> fmt::Debug for DecodeReaderBytes<R, B> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let mut fmter = f.debug_struct("DecodeReaderBytes");
        fmter
            .field("rdr", &self.rdr)
            .field("tiny", &self.tiny)
            .field("utf8_passthru", &self.utf8_passthru)
            .field("buf", &self.buf)
            .field("pos", &self.pos)
            .field("buflen", &self.buflen)
            .field("has_detected", &self.has_detected)
            .field("exhausted", &self.exhausted);
        // Because `encoding_rs::Decoder` doesn't impl `fmt::Debug`.
        if let Some(ref d) = self.decoder {
            let msg = format!("Some(<Decoder for {}>)", d.encoding().name());
            fmter.field("decoder", &msg);
        } else {
            fmter.field("decoder", &"None");
        }
        fmter.finish()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use encoding_rs::{self, Encoding};

    use super::{DecodeReaderBytes, DecodeReaderBytesBuilder};

    fn read_to_string<R: Read>(mut rdr: R) -> String {
        let mut s = String::new();
        rdr.read_to_string(&mut s).unwrap();
        s
    }

    // In cases where all we have is a bom, we expect the bytes to be
    // passed through unchanged.
    #[test]
    fn trans_utf16_bom() {
        let srcbuf = vec![0xFF, 0xFE];
        let mut dstbuf = vec![0; 8 * (1 << 10)];
        let mut rdr = DecodeReaderBytes::new(&*srcbuf);
        let n = rdr.read(&mut dstbuf).unwrap();
        assert_eq!(&*srcbuf, &dstbuf[..n]);

        let srcbuf = vec![0xFE, 0xFF];
        let mut rdr = DecodeReaderBytes::new(&*srcbuf);
        let n = rdr.read(&mut dstbuf).unwrap();
        assert_eq!(&*srcbuf, &dstbuf[..n]);

        let srcbuf = vec![0xEF, 0xBB, 0xBF];
        let mut rdr = DecodeReaderBytes::new(&*srcbuf);
        let n = rdr.read(&mut dstbuf).unwrap();
        assert_eq!(n, 0);

        let srcbuf = vec![0xEF, 0xBB, 0xBF];
        let mut rdr = DecodeReaderBytesBuilder::new()
            .utf8_passthru(true)
            .build(&*srcbuf);
        let n = rdr.read(&mut dstbuf).unwrap();
        assert_eq!(&*srcbuf, &dstbuf[..n]);
    }

    // Test basic UTF-16 decoding.
    #[test]
    fn trans_utf16_basic() {
        let srcbuf = vec![0xFF, 0xFE, 0x61, 0x00];
        let mut rdr = DecodeReaderBytes::new(&*srcbuf);
        assert_eq!("a", read_to_string(&mut rdr));

        let srcbuf = vec![0xFE, 0xFF, 0x00, 0x61];
        let mut rdr = DecodeReaderBytes::new(&*srcbuf);
        assert_eq!("a", read_to_string(&mut rdr));
    }

    #[test]
    fn trans_utf16_basic_without_bom() {
        let srcbuf = vec![0xFF, 0xFE, 0x61, 0x00];
        let mut rdr =
            DecodeReaderBytesBuilder::new().strip_bom(true).build(&*srcbuf);
        assert_eq!("a", read_to_string(&mut rdr));

        let srcbuf = vec![0xFE, 0xFF, 0x00, 0x61];
        let mut rdr =
            DecodeReaderBytesBuilder::new().strip_bom(true).build(&*srcbuf);
        assert_eq!("a", read_to_string(&mut rdr));
    }

    // Test the BOM override.
    #[test]
    fn trans_utf16_bom_override() {
        let srcbuf = vec![0xFF, 0xFE, 0x61, 0x00];
        let mut rdr = DecodeReaderBytesBuilder::new()
            .bom_override(true)
            .encoding(Some(encoding_rs::UTF_8))
            .build(&*srcbuf);
        assert_eq!("a", read_to_string(&mut rdr));
    }

    // Test basic UTF-16 decoding with a small  buffer.
    #[test]
    fn trans_utf16_smallbuf() {
        let srcbuf = vec![0xFF, 0xFE, 0x61, 0x00, 0x62, 0x00, 0x63, 0x00];
        let mut rdr = DecodeReaderBytes::new(&*srcbuf);
        let mut tmp = [0u8; 1];

        let nread = rdr.read(&mut tmp).unwrap();
        assert_eq!(nread, 1);
        assert_eq!(tmp, [b'a'; 1]);

        let nread = rdr.read(&mut tmp).unwrap();
        assert_eq!(nread, 1);
        assert_eq!(tmp, [b'b'; 1]);

        let nread = rdr.read(&mut tmp).unwrap();
        assert_eq!(nread, 1);
        assert_eq!(tmp, [b'c'; 1]);

        let nread = rdr.read(&mut tmp).unwrap();
        assert_eq!(nread, 0);
    }

    // Test incomplete UTF-16 decoding. This ensures we see a replacement char
    // if the stream ends with an unpaired code unit.
    #[test]
    fn trans_utf16_incomplete() {
        let srcbuf = vec![0xFF, 0xFE, 0x61, 0x00, 0x00];
        let mut rdr = DecodeReaderBytes::new(&*srcbuf);
        assert_eq!("a\u{FFFD}", read_to_string(&mut rdr));
    }

    // Test transcoding with a minimal buffer but a large caller buffer.
    #[test]
    fn trans_utf16_minimal_buffer_normal_caller_buffer() {
        #[rustfmt::skip]
        let srcbuf = vec![
            0xFF, 0xFE,
            0x61, 0x00,
            0x62, 0x00,
            0x63, 0x00,
            0x64, 0x00,
            0x65, 0x00,
            0x66, 0x00,
            0x67, 0x00,
            0x68, 0x00,
        ];
        let mut rdr = DecodeReaderBytesBuilder::new()
            .build_with_buffer(&*srcbuf, vec![0; 4])
            .unwrap();
        let got = read_to_string(&mut rdr);
        assert_eq!(got, "abcdefgh");
    }

    // Test transcoding with a minimal buffer and a minimal caller buffer.
    #[test]
    fn trans_utf16_minimal_buffers() {
        let srcbuf = vec![0xFF, 0xFE, 0x61, 0x00, 0x62, 0x00, 0x63, 0x00];
        let mut rdr = DecodeReaderBytesBuilder::new()
            .build_with_buffer(&*srcbuf, vec![0; 4])
            .unwrap();
        let mut tmp = [0u8; 1];

        let nread = rdr.read(&mut tmp).unwrap();
        assert_eq!(nread, 1);
        assert_eq!(tmp, [b'a'; 1]);

        let nread = rdr.read(&mut tmp).unwrap();
        assert_eq!(nread, 1);
        assert_eq!(tmp, [b'b'; 1]);

        let nread = rdr.read(&mut tmp).unwrap();
        assert_eq!(nread, 1);
        assert_eq!(tmp, [b'c'; 1]);

        let nread = rdr.read(&mut tmp).unwrap();
        assert_eq!(nread, 0);
    }

    // Test transcoding with using byte oriented APIs.
    #[test]
    fn trans_utf16_byte_api() {
        #[rustfmt::skip]
        let srcbuf = vec![
            0xFF, 0xFE,
            0x61, 0x00,
            0x62, 0x00,
            0x63, 0x00,
            0x64, 0x00,
            0x65, 0x00,
            0x66, 0x00,
            0x67, 0x00,
            0x68, 0x00,
        ];
        let rdr = DecodeReaderBytes::new(&*srcbuf);
        let got: Vec<u8> = rdr.bytes().map(|res| res.unwrap()).collect();
        assert_eq!(got, b"abcdefgh");
    }

    #[test]
    fn trans_utf16_no_sniffing() {
        #[rustfmt::skip]
        let srcbuf = vec![
            0xFF, 0xFE,
            0x61, 0x00,
        ];
        let rdr = DecodeReaderBytesBuilder::new()
            .bom_sniffing(false)
            .build(&*srcbuf);
        let got: Vec<u8> = rdr.bytes().map(|res| res.unwrap()).collect();
        assert_eq!(got, srcbuf);
    }

    #[test]
    fn trans_utf16_no_sniffing_strip_bom() {
        #[rustfmt::skip]
        let srcbuf = vec![
            0xFF, 0xFE,
            0x61, 0x00,
        ];
        let rdr = DecodeReaderBytesBuilder::new()
            .bom_sniffing(false)
            .strip_bom(true)
            .build(&*srcbuf);
        let got: Vec<u8> = rdr.bytes().map(|res| res.unwrap()).collect();
        assert_eq!(got, &[0x61, 0x00]);
    }

    #[test]
    fn trans_utf16_no_sniffing_encoding_override() {
        #[rustfmt::skip]
        let srcbuf = vec![
            0xFF, 0xFE,
            0x61, 0x00,
        ];
        let rdr = DecodeReaderBytesBuilder::new()
            .bom_sniffing(false)
            .encoding(Some(encoding_rs::UTF_16LE))
            .build(&*srcbuf);
        let got: Vec<u8> = rdr.bytes().map(|res| res.unwrap()).collect();
        assert_eq!(got, b"a");
    }

    #[test]
    fn trans_utf16_no_sniffing_encoding_override_strip_bom() {
        #[rustfmt::skip]
        let srcbuf = vec![
            0xFF, 0xFE,
            0x61, 0x00,
        ];
        let rdr = DecodeReaderBytesBuilder::new()
            .bom_sniffing(false)
            .strip_bom(true)
            .encoding(Some(encoding_rs::UTF_16LE))
            .build(&*srcbuf);
        let got: Vec<u8> = rdr.bytes().map(|res| res.unwrap()).collect();
        assert_eq!(got, b"a");
    }

    // Test transcoding with a minimal buffer using byte oriented APIs.
    #[test]
    fn trans_utf16_minimal_buffer_byte_api() {
        #[rustfmt::skip]
        let srcbuf = vec![
            0xFF, 0xFE,
            0x61, 0x00,
            0x62, 0x00,
            0x63, 0x00,
            0x64, 0x00,
            0x65, 0x00,
            0x66, 0x00,
            0x67, 0x00,
            0x68, 0x00,
        ];
        let rdr = DecodeReaderBytesBuilder::new()
            .build_with_buffer(&*srcbuf, vec![0; 4])
            .unwrap();
        let got: Vec<u8> = rdr.bytes().map(|res| res.unwrap()).collect();
        assert_eq!(got, b"abcdefgh");
    }

    // Test a buffer that is too small.
    #[test]
    fn buffer_too_small() {
        let res = DecodeReaderBytesBuilder::new()
            .build_with_buffer(&[][..], vec![0; 3]);
        assert!(res.is_err());
    }

    macro_rules! test_trans_simple {
        ($name:ident, $enc:expr, $srcbytes:expr, $dst:expr) => {
            #[test]
            fn $name() {
                let srcbuf = &$srcbytes[..];
                let enc = Encoding::for_label($enc.as_bytes());
                let mut rdr = DecodeReaderBytesBuilder::new()
                    .encoding(enc)
                    .build(&*srcbuf);
                assert_eq!($dst, read_to_string(&mut rdr));
            }
        };
    }

    // This isn't exhaustive obviously, but it lets us test base level support.
    test_trans_simple!(trans_simple_auto, "does not exist", b"\xD0\x96", "Ж");
    test_trans_simple!(trans_simple_utf8, "utf-8", b"\xD0\x96", "Ж");
    test_trans_simple!(trans_simple_utf16le, "utf-16le", b"\x16\x04", "Ж");
    test_trans_simple!(trans_simple_utf16be, "utf-16be", b"\x04\x16", "Ж");
    test_trans_simple!(trans_simple_chinese, "chinese", b"\xA7\xA8", "Ж");
    test_trans_simple!(trans_simple_korean, "korean", b"\xAC\xA8", "Ж");
    test_trans_simple!(
        trans_simple_big5_hkscs,
        "big5-hkscs",
        b"\xC7\xFA",
        "Ж"
    );
    test_trans_simple!(trans_simple_gbk, "gbk", b"\xA7\xA8", "Ж");
    test_trans_simple!(trans_simple_sjis, "sjis", b"\x84\x47", "Ж");
    test_trans_simple!(trans_simple_eucjp, "euc-jp", b"\xA7\xA8", "Ж");
    test_trans_simple!(trans_simple_latin1, "latin1", b"\xA9", "©");
}
