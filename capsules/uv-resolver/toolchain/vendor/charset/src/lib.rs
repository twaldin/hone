// Copyright Mozilla Foundation. See the COPYRIGHT
// file at the top-level directory of this distribution.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// https://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or https://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

//! `charset` is a wrapper around [`encoding_rs`][1] that provides
//! (non-streaming) decoding for character encodings that occur in _email_ by
//! providing decoding for [UTF-7][2] in addition to the encodings defined by
//! the [Encoding Standard][3] (and provided by `encoding_rs`).
//!
//! _Note:_ Do _not_ use this crate for consuming _Web_ content. For security
//! reasons, consumers of Web content are [_prohibited_][4] from supporting
//! UTF-7. Use `encoding_rs` directly when consuming Web content.
//!
//! The set of encodings consisting of UTF-7 and the encodings defined in the
//! Encoding Standard is believed to be appropriate for consuming email,
//! because that's the set of encodings supported by [Thunderbird][5].
//! Furthermore, UTF-7 support is believed to be necessary based on the
//! experience of the Firefox OS email client. In fact, while the UTF-7
//! implementation in this crate is independent of Thunderbird's UTF-7
//! implementation, Thunderbird uses `encoding_rs` to decode the other
//! encodings. In addition to the labels defined in the Encoding Standard,
//! this crate recognizes additional `java.io` and `java.nio` names for
//! compatibility with JavaMail. For UTF-7, IANA and Netscape 4.0 labels
//! are recognized.
//!
//! Known compatibility limitations (known from Thunderbird bug reports):
//!
//!  * Some ancient Usenet posting in Chinese may not be decodable, because
//!    this crate does not support HZ.
//!  * Some emails sent in Chinese by Sun's email client for CDE on Solaris
//!    around the turn of the millennium may not decodable, because this
//!    crate does not support ISO-2022-CN.
//!  * Some emails sent in Korean by IBM/Lotus Notes may not be decodable,
//!    because this crate does not support ISO-2022-KR.
//!
//! This crate intentionally does not support encoding content into legacy
//! encodings. When sending email, _always_ use UTF-8. This is, just call
//! `.as_bytes()` on `&str` and label the content as `UTF-8`.
//!
//! [1]: https://crates.io/crates/encoding_rs/
//! [2]: https://tools.ietf.org/html/rfc2152
//! [3]: https://encoding.spec.whatwg.org/
//! [4]: https://html.spec.whatwg.org/#character-encodings
//! [5]: https://thunderbird.net/
//!
//! # Security considerations
//!
//! Again, this crate is for _email_. Please do _NOT_ use it for _Web_
//! content.
//!
//! Never try to perform any security analysis on the undecoded data in
//! ASCII-incompatible encodings and in UTF-7 in particular. Always decode
//! first and analyze after. UTF-7 allows even characters that don't have to
//! be represeted as base64 to be represented as base64. Also, for consistency
//! with Thunderbird, the UTF-7 decoder in this crate allows e.g. ASCII
//! controls to be represented without base64 encoding even when the spec
//! says they should be base64-encoded.
//!
//! This implementation is non-constant-time by design. An attacker who
//! can observe input length and the time it takes to decode it can make
//! guesses about relative proportions of characters from different ranges.
//! Guessing the proportion of ASCII vs. non-ASCII should be particularly
//! feasible.

#![no_std]

#[cfg_attr(feature = "serde", macro_use)]
extern crate alloc;
extern crate base64;
extern crate encoding_rs;

#[cfg(feature = "serde")]
extern crate serde;

#[cfg(all(test, feature = "serde"))]
extern crate bincode;
#[cfg(all(test, feature = "serde"))]
#[macro_use]
extern crate serde_derive;
#[cfg(all(test, feature = "serde"))]
extern crate serde_json;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;
use encoding_rs::CoderResult;
use encoding_rs::Encoding;
use encoding_rs::GB18030;
use encoding_rs::GBK;
use encoding_rs::UTF_16BE;

use alloc::borrow::Cow;
use alloc::string::String;
use alloc::vec::Vec;

use core::cmp::Ordering;

#[cfg(feature = "serde")]
use serde::de::Visitor;
#[cfg(feature = "serde")]
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The UTF-7 encoding.
pub const UTF_7: Charset = Charset {
    variant: VariantCharset::Utf7,
};

/// Converts bytes whose unsigned value is interpreted as Unicode code point
/// (i.e. U+0000 to U+00FF, inclusive) to UTF-8.
///
/// This is useful for decoding non-conforming header names such that the
/// names stay unique and the decoding cannot fail (except for allocation
/// failure).
///
/// Borrows if input is ASCII-only. Performs a single heap allocation
/// otherwise.
pub fn decode_latin1<'a>(bytes: &'a [u8]) -> Cow<'a, str> {
    encoding_rs::mem::decode_latin1(bytes)
}

/// Converts ASCII to UTF-8 with non-ASCII bytes replaced with the
/// REPLACEMENT CHARACTER.
///
/// This is can be used for strict MIME compliance when there is no declared
/// encoding.
///
/// Borrows if input is ASCII-only. Performs a single heap allocation
/// otherwise.
pub fn decode_ascii<'a>(bytes: &'a [u8]) -> Cow<'a, str> {
    let up_to = Encoding::ascii_valid_up_to(bytes);
    // >= makes later things optimize better than ==
    if up_to >= bytes.len() {
        debug_assert_eq!(up_to, bytes.len());
        let s: &str = unsafe { ::core::str::from_utf8_unchecked(bytes) };
        return Cow::Borrowed(s);
    }
    let (head, tail) = bytes.split_at(up_to);
    let capacity = head.len() + tail.len() * 3;
    let mut vec = Vec::with_capacity(capacity);
    vec.extend_from_slice(head);
    for &b in tail.into_iter() {
        if b < 0x80 {
            vec.push(b);
        } else {
            vec.extend_from_slice("\u{FFFD}".as_bytes());
        }
    }
    Cow::Owned(unsafe { String::from_utf8_unchecked(vec) })
}

/// A character encoding suitable for decoding _email_.
///
/// This is either an encoding as defined in the [Encoding Standard][1]
/// or UTF-7 as defined in [RFC 2152][2].
///
/// [1]: https://encoding.spec.whatwg.org/
/// [2]: https://tools.ietf.org/html/rfc2152
///
/// Each `Charset` has one or more _labels_ that are used to identify
/// the `Charset` in protocol text. In MIME/IANA terminology, these are
/// called _names_ and _aliases_, but for consistency with the Encoding
/// Standard and the encoding_rs crate, they are called labels in this
/// crate. What this crate calls the _name_ (again, for consistency
/// with the Encoding Standard and the encoding_rs crate) is known as
/// _preferred name_ in MIME/IANA terminology.
///
/// Instances of `Charset` can be compared with `==`. `Charset` is
/// `Copy` and is meant to be passed by value.
///
/// _Note:_ It is wrong to use this for decoding Web content. Use
/// `encoding_rs::Encoding` instead!
#[derive(PartialEq, Debug, Copy, Clone, Hash)]
pub struct Charset {
    variant: VariantCharset,
}

impl Charset {
    /// Implements the
    /// [_get an encoding_](https://encoding.spec.whatwg.org/#concept-encoding-get)
    /// algorithm with the label "UTF-7" added to the set of labels recognized.
    /// GBK is unified with gb18030, since they decode the same and `Charset`
    /// only supports decoding.
    ///
    /// If, after ASCII-lowercasing and removing leading and trailing
    /// whitespace, the argument matches a label defined in the Encoding
    /// Standard or "utf-7", `Some(Charset)` representing the corresponding
    /// encoding is returned. If there is no match, `None` is returned.
    ///
    /// This is the right method to use if the action upon the method returning
    /// `None` is to use a fallback encoding (e.g. `WINDOWS_1252`) instead.
    /// When the action upon the method returning `None` is not to proceed with
    /// a fallback but to refuse processing, `for_label_no_replacement()` is more
    /// appropriate.
    ///
    /// The argument is of type `&[u8]` instead of `&str` to save callers
    /// that are extracting the label from a non-UTF-8 protocol the trouble
    /// of conversion to UTF-8. (If you have a `&str`, just call `.as_bytes()`
    /// on it.)
    #[inline]
    pub fn for_label(label: &[u8]) -> Option<Charset> {
        if let Some(encoding) = Encoding::for_label(label) {
            Some(Charset::for_encoding(encoding))
        } else if let Some(variant_charset) = for_label_extended(label) {
            Some(Charset {
                variant: variant_charset,
            })
        } else {
            None
        }
    }

    /// This method behaves the same as `for_label()`, except when `for_label()`
    /// would return `Some(Charset::for_encoding(encoding_rs::REPLACEMENT))`,
    /// this method returns `None` instead.
    ///
    /// This method is useful in scenarios where a fatal error is required
    /// upon invalid label, because in those cases the caller typically wishes
    /// to treat the labels that map to the replacement encoding as fatal
    /// errors, too.
    ///
    /// It is not OK to use this method when the action upon the method returning
    /// `None` is to use a fallback encoding (e.g. `WINDOWS_1252`) with `text/html`
    /// email. In such a case, the `for_label()` method should be used instead in
    /// order to avoid unsafe fallback for labels that `for_label()` maps to
    /// `Some(REPLACEMENT)`. Such fallback might be safe, though not particularly
    /// useful for `text/plain` email, though.
    #[inline]
    pub fn for_label_no_replacement(label: &[u8]) -> Option<Charset> {
        if let Some(encoding) = Encoding::for_label_no_replacement(label) {
            Some(Charset::for_encoding(encoding))
        } else if let Some(variant_charset) = for_label_extended(label) {
            Some(Charset {
                variant: variant_charset,
            })
        } else {
            None
        }
    }

    /// Returns the `Charset` corresponding to an `&'static Encoding`.
    ///
    /// `GBK` is unified with `GB18030`, since those two decode the same
    /// and `Charset` only supports decoding.
    #[inline]
    pub fn for_encoding(encoding: &'static Encoding) -> Charset {
        let enc = if encoding == GBK { GB18030 } else { encoding };
        Charset {
            variant: VariantCharset::Encoding(enc),
        }
    }

    /// Performs non-incremental BOM sniffing.
    ///
    /// The argument must either be a buffer representing the entire input
    /// stream (non-streaming case) or a buffer representing at least the first
    /// three bytes of the input stream (streaming case).
    ///
    /// Returns `Some((Charset::for_encoding(encoding_rs::UTF_8), 3))`,
    /// `Some((Charset::for_encoding(encoding_rs::UTF_16LE), 2))` or
    /// `Some((Charset::for_encoding(encoding_rs::UTF_16BE), 2))` if the
    /// argument starts with the UTF-8, UTF-16LE or UTF-16BE BOM or `None`
    /// otherwise.
    #[inline]
    pub fn for_bom(buffer: &[u8]) -> Option<(Charset, usize)> {
        if let Some((encoding, length)) = Encoding::for_bom(buffer) {
            Some((Charset::for_encoding(encoding), length))
        } else {
            None
        }
    }

    /// Returns the name of this encoding.
    ///
    /// Mostly useful for debugging
    pub fn name(self) -> &'static str {
        match self.variant {
            VariantCharset::Encoding(encoding) => encoding.name(),
            VariantCharset::Utf7 => "UTF-7",
        }
    }

    /// Checks whether the bytes 0x00...0x7F map exclusively to the characters
    /// U+0000...U+007F and vice versa.
    #[inline]
    pub fn is_ascii_compatible(self) -> bool {
        match self.variant {
            VariantCharset::Encoding(encoding) => encoding.is_ascii_compatible(),
            VariantCharset::Utf7 => false,
        }
    }

    /// Decode complete input to `Cow<'a, str>` _with BOM sniffing_ and with
    /// malformed sequences replaced with the REPLACEMENT CHARACTER when the
    /// entire input is available as a single buffer (i.e. the end of the
    /// buffer marks the end of the stream).
    ///
    /// This method implements the (non-streaming version of) the
    /// [_decode_](https://encoding.spec.whatwg.org/#decode) spec concept.
    ///
    /// The second item in the returned tuple is the encoding that was actually
    /// used (which may differ from this encoding thanks to BOM sniffing).
    ///
    /// The third item in the returned tuple indicates whether there were
    /// malformed sequences (that were replaced with the REPLACEMENT CHARACTER).
    ///
    /// _Note:_ It is wrong to use this when the input buffer represents only
    /// a segment of the input instead of the whole input.
    ///
    /// # Panics
    ///
    /// If the size calculation for a heap-allocated backing buffer overflows
    /// `usize`.
    #[inline]
    pub fn decode<'a>(self, bytes: &'a [u8]) -> (Cow<'a, str>, Charset, bool) {
        let (charset, without_bom) = match Charset::for_bom(bytes) {
            Some((charset, bom_length)) => (charset, &bytes[bom_length..]),
            None => (self, bytes),
        };
        let (cow, had_errors) = charset.decode_without_bom_handling(without_bom);
        (cow, charset, had_errors)
    }

    /// Decode complete input to `Cow<'a, str>` _with BOM removal_ and with
    /// malformed sequences replaced with the REPLACEMENT CHARACTER when the
    /// entire input is available as a single buffer (i.e. the end of the
    /// buffer marks the end of the stream).
    ///
    /// When invoked on `UTF_8`, this method implements the (non-streaming
    /// version of) the
    /// [_UTF-8 decode_](https://encoding.spec.whatwg.org/#utf-8-decode) spec
    /// concept.
    ///
    /// The second item in the returned pair indicates whether there were
    /// malformed sequences (that were replaced with the REPLACEMENT CHARACTER).
    ///
    /// _Note:_ It is wrong to use this when the input buffer represents only
    /// a segment of the input instead of the whole input.
    ///
    /// # Panics
    ///
    /// If the size calculation for a heap-allocated backing buffer overflows
    /// `usize`.
    #[inline]
    pub fn decode_with_bom_removal<'a>(self, bytes: &'a [u8]) -> (Cow<'a, str>, bool) {
        match self.variant {
            VariantCharset::Encoding(encoding) => encoding.decode_with_bom_removal(bytes),
            VariantCharset::Utf7 => decode_utf7(bytes),
        }
    }

    /// Decode complete input to `Cow<'a, str>` _without BOM handling_ and
    /// with malformed sequences replaced with the REPLACEMENT CHARACTER when
    /// the entire input is available as a single buffer (i.e. the end of the
    /// buffer marks the end of the stream).
    ///
    /// When invoked on `UTF_8`, this method implements the (non-streaming
    /// version of) the
    /// [_UTF-8 decode without BOM_](https://encoding.spec.whatwg.org/#utf-8-decode-without-bom)
    /// spec concept.
    ///
    /// The second item in the returned pair indicates whether there were
    /// malformed sequences (that were replaced with the REPLACEMENT CHARACTER).
    ///
    /// _Note:_ It is wrong to use this when the input buffer represents only
    /// a segment of the input instead of the whole input.
    ///
    /// # Panics
    ///
    /// If the size calculation for a heap-allocated backing buffer overflows
    /// `usize`.
    #[inline]
    pub fn decode_without_bom_handling<'a>(self, bytes: &'a [u8]) -> (Cow<'a, str>, bool) {
        match self.variant {
            VariantCharset::Encoding(encoding) => encoding.decode_without_bom_handling(bytes),
            VariantCharset::Utf7 => decode_utf7(bytes),
        }
    }
}

impl From<&'static Encoding> for Charset {
    fn from(encoding: &'static Encoding) -> Self {
        Charset::for_encoding(encoding)
    }
}

#[cfg(feature = "serde")]
impl Serialize for Charset {
    #[inline]
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.name())
    }
}

#[cfg(feature = "serde")]
struct CharsetVisitor;

#[cfg(feature = "serde")]
impl<'de> Visitor<'de> for CharsetVisitor {
    type Value = Charset;

    fn expecting(&self, formatter: &mut core::fmt::Formatter) -> core::fmt::Result {
        formatter.write_str("a valid charset label")
    }

    fn visit_str<E>(self, value: &str) -> Result<Charset, E>
    where
        E: serde::de::Error,
    {
        if let Some(charset) = Charset::for_label(value.as_bytes()) {
            Ok(charset)
        } else {
            Err(E::custom(format!("invalid charset label: {}", value)))
        }
    }
}

#[cfg(feature = "serde")]
impl<'de> Deserialize<'de> for Charset {
    fn deserialize<D>(deserializer: D) -> Result<Charset, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_str(CharsetVisitor)
    }
}

static LABELS_SORTED: [&'static str; 29] = [
    "ms950",
    "ms874",
    "ms936",
    "utf-7",
    "ms949",
    "tis620",
    "euc_cn",
    "euc_jp",
    "koi8_r",
    "euc_kr",
    "koi8_u",
    "iso8859_1",
    "iso8859_2",
    "iso8859_3",
    "iso8859_4",
    "iso8859_5",
    "iso8859_6",
    "iso8859_7",
    "iso8859_9",
    "iso2022jp",
    "iso8859_13",
    "iso8859_15",
    "ms950_hkscs",
    "x-windows-950",
    "x-windows-874",
    "x-windows-949",
    "csunicode11utf7",
    "unicode-1-1-utf-7",
    "x-unicode-2-0-utf-7",
];

static ENCODINGS_IN_LABEL_SORT: [VariantCharset; 29] = [
    VariantCharset::Encoding(&encoding_rs::BIG5_INIT),
    VariantCharset::Encoding(&encoding_rs::WINDOWS_874_INIT),
    VariantCharset::Encoding(&encoding_rs::GB18030_INIT),
    VariantCharset::Utf7,
    VariantCharset::Encoding(&encoding_rs::EUC_KR_INIT),
    VariantCharset::Encoding(&encoding_rs::WINDOWS_874_INIT),
    VariantCharset::Encoding(&encoding_rs::GB18030_INIT),
    VariantCharset::Encoding(&encoding_rs::EUC_JP_INIT),
    VariantCharset::Encoding(&encoding_rs::KOI8_R_INIT),
    VariantCharset::Encoding(&encoding_rs::EUC_KR_INIT),
    VariantCharset::Encoding(&encoding_rs::KOI8_U_INIT),
    VariantCharset::Encoding(&encoding_rs::WINDOWS_1252_INIT),
    VariantCharset::Encoding(&encoding_rs::ISO_8859_2_INIT),
    VariantCharset::Encoding(&encoding_rs::ISO_8859_3_INIT),
    VariantCharset::Encoding(&encoding_rs::ISO_8859_4_INIT),
    VariantCharset::Encoding(&encoding_rs::ISO_8859_5_INIT),
    VariantCharset::Encoding(&encoding_rs::ISO_8859_6_INIT),
    VariantCharset::Encoding(&encoding_rs::ISO_8859_7_INIT),
    VariantCharset::Encoding(&encoding_rs::WINDOWS_1254_INIT),
    VariantCharset::Encoding(&encoding_rs::ISO_2022_JP_INIT),
    VariantCharset::Encoding(&encoding_rs::ISO_8859_13_INIT),
    VariantCharset::Encoding(&encoding_rs::ISO_8859_15_INIT),
    VariantCharset::Encoding(&encoding_rs::BIG5_INIT),
    VariantCharset::Encoding(&encoding_rs::BIG5_INIT),
    VariantCharset::Encoding(&encoding_rs::WINDOWS_874_INIT),
    VariantCharset::Encoding(&encoding_rs::EUC_KR_INIT),
    VariantCharset::Utf7,
    VariantCharset::Utf7,
    VariantCharset::Utf7,
];

const LONGEST_LABEL_LENGTH: usize = 19; // x-unicode-2-0-utf-7

/// Copypaste from encoding_rs to search over the labels known to this
/// crate but not encoding_rs.
#[inline(never)]
fn for_label_extended(label: &[u8]) -> Option<VariantCharset> {
    let mut trimmed = [0u8; LONGEST_LABEL_LENGTH];
    let mut trimmed_pos = 0usize;
    let mut iter = label.into_iter();
    // before
    loop {
        match iter.next() {
            None => {
                return None;
            }
            Some(byte) => {
                // The characters used in labels are:
                // a-z (except q, but excluding it below seems excessive)
                // 0-9
                // . _ - :
                match *byte {
                    0x09u8 | 0x0Au8 | 0x0Cu8 | 0x0Du8 | 0x20u8 => {
                        continue;
                    }
                    b'A'..=b'Z' => {
                        trimmed[trimmed_pos] = *byte + 0x20u8;
                        trimmed_pos = 1usize;
                        break;
                    }
                    b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b':' | b'.' => {
                        trimmed[trimmed_pos] = *byte;
                        trimmed_pos = 1usize;
                        break;
                    }
                    _ => {
                        return None;
                    }
                }
            }
        }
    }
    // inside
    loop {
        match iter.next() {
            None => {
                break;
            }
            Some(byte) => {
                match *byte {
                    0x09u8 | 0x0Au8 | 0x0Cu8 | 0x0Du8 | 0x20u8 => {
                        break;
                    }
                    b'A'..=b'Z' => {
                        if trimmed_pos == LONGEST_LABEL_LENGTH {
                            // There's no encoding with a label this long
                            return None;
                        }
                        trimmed[trimmed_pos] = *byte + 0x20u8;
                        trimmed_pos += 1usize;
                        continue;
                    }
                    b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b':' | b'.' => {
                        if trimmed_pos == LONGEST_LABEL_LENGTH {
                            // There's no encoding with a label this long
                            return None;
                        }
                        trimmed[trimmed_pos] = *byte;
                        trimmed_pos += 1usize;
                        continue;
                    }
                    _ => {
                        return None;
                    }
                }
            }
        }
    }
    // after
    loop {
        match iter.next() {
            None => {
                break;
            }
            Some(byte) => {
                match *byte {
                    0x09u8 | 0x0Au8 | 0x0Cu8 | 0x0Du8 | 0x20u8 => {
                        continue;
                    }
                    _ => {
                        // There's no label with space in the middle
                        return None;
                    }
                }
            }
        }
    }
    let candidate = &trimmed[..trimmed_pos];
    match LABELS_SORTED.binary_search_by(|probe| {
        let bytes = probe.as_bytes();
        let c = bytes.len().cmp(&candidate.len());
        if c != Ordering::Equal {
            return c;
        }
        let probe_iter = bytes.iter().rev();
        let candidate_iter = candidate.iter().rev();
        probe_iter.cmp(candidate_iter)
    }) {
        Ok(i) => Some(ENCODINGS_IN_LABEL_SORT[i]),
        Err(_) => None,
    }
}

#[inline]
fn utf7_ascii_up_to(bytes: &[u8]) -> usize {
    for (i, &byte) in bytes.into_iter().enumerate() {
        if byte == b'+' || byte >= 0x80 {
            return i;
        }
    }
    bytes.len()
}

#[inline]
fn utf7_base64_up_to(bytes: &[u8]) -> usize {
    for (i, &byte) in bytes.into_iter().enumerate() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'+' | b'/' => {}
            _ => {
                return i;
            }
        }
    }
    bytes.len()
}

#[inline]
fn utf7_base64_decode(bytes: &[u8], string: &mut String) -> bool {
    // The intermediate buffer should be long enough to fit a line
    // of 80 base64 bytes and should also be a multiple of 3. This
    // way, normal email lines will be handled in one go, but
    // longer sequences won't get split between base64 groups of
    // 4 input / 3 output bytes.
    let mut decoder = UTF_16BE.new_decoder_without_bom_handling();
    let mut buf = [0u8; 60];
    let mut tail = bytes;
    let mut had_errors = false;
    let mut trailing_error = false;
    loop {
        let (last, mut cap) = if tail.len() <= 80 {
            (true, tail.len())
        } else {
            (false, 80)
        };
        let len;
        loop {
            match STANDARD_NO_PAD.decode_slice(&tail[..cap], &mut buf[..]) {
                Ok(l) => {
                    len = l;
                    break;
                }
                Err(_) => {
                    assert!(last);
                    had_errors = true;
                    trailing_error = true;
                    tail = &tail[..tail.len() - 1];
                    cap -= 1;
                }
            }
        }
        let mut total_read = 0;
        loop {
            let (result, read, err) = decoder.decode_to_string(&buf[total_read..len], string, last);
            total_read += read;
            had_errors |= err;
            match result {
                CoderResult::InputEmpty => {
                    if last {
                        if trailing_error {
                            string.push_str("\u{FFFD}");
                        }
                        return had_errors;
                    }
                    break;
                }
                CoderResult::OutputFull => {
                    let left = len - total_read;
                    let needed = decoder.max_utf8_buffer_length(left).unwrap();
                    string.reserve(needed);
                }
            }
        }
        tail = &tail[80..];
    }
}

#[inline(never)]
fn decode_utf7<'a>(bytes: &'a [u8]) -> (Cow<'a, str>, bool) {
    let up_to = utf7_ascii_up_to(bytes);
    if up_to == bytes.len() {
        let s: &str = unsafe { core::str::from_utf8_unchecked(bytes) };
        return (Cow::Borrowed(s), false);
    }
    let mut had_errors = false;
    let mut out = String::with_capacity(bytes.len());
    out.push_str(unsafe { core::str::from_utf8_unchecked(&bytes[..up_to]) });

    let mut tail = &bytes[up_to..];
    loop {
        // `tail[0]` is now either a plus sign or non-ASCII
        let first = tail[0];
        tail = &tail[1..];
        if first == b'+' {
            let up_to = utf7_base64_up_to(tail);
            had_errors |= utf7_base64_decode(&tail[..up_to], &mut out);
            if up_to == tail.len() {
                if up_to == 0 {
                    // Plus sign didn't start a base64 run and also
                    // wasn't followed by a minus.
                    had_errors = true;
                    out.push_str("\u{FFFD}");
                }
                return (Cow::Owned(out), had_errors);
            }
            if up_to == 0 {
                if tail[up_to] == b'-' {
                    // There was no base64 data between
                    // plus and minus, so we had the sequence
                    // meaning the plus sign itself.
                    out.push_str("+");
                    tail = &tail[up_to + 1..];
                } else {
                    // Plus sign didn't start a base64 run and also
                    // wasn't followed by a minus.
                    had_errors = true;
                    out.push_str("\u{FFFD}");
                }
            } else if tail[up_to] == b'-' {
                tail = &tail[up_to + 1..];
            } else {
                tail = &tail[up_to..];
            }
        } else {
            had_errors = true;
            out.push_str("\u{FFFD}");
        }
        let up_to = utf7_ascii_up_to(tail);
        out.push_str(unsafe { core::str::from_utf8_unchecked(&tail[..up_to]) });
        if up_to == tail.len() {
            return (Cow::Owned(out), had_errors);
        }
        tail = &tail[up_to..];
    }
}

#[derive(PartialEq, Debug, Copy, Clone, Hash)]
enum VariantCharset {
    Utf7,
    Encoding(&'static Encoding),
}

#[cfg(all(test, feature = "serde"))]
#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Demo {
    num: u32,
    name: String,
    charset: Charset,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf7_no_err(bytes: &[u8]) -> String {
        let (cow, had_errors) = UTF_7.decode_without_bom_handling(bytes);
        assert!(!had_errors);
        cow.into()
    }

    fn utf7_err(bytes: &[u8]) -> String {
        let (cow, had_errors) = UTF_7.decode_without_bom_handling(bytes);
        assert!(had_errors);
        cow.into()
    }

    // Any copyright to the test code below this comment is dedicated to the
    // Public Domain. https://creativecommons.org/publicdomain/zero/1.0/

    #[test]
    fn test_for_label() {
        assert_eq!(Charset::for_label(b"  uTf-7\t "), Some(UTF_7));
        assert_eq!(
            Charset::for_label(b"  uTf-8\t "),
            Some(Charset::for_encoding(encoding_rs::UTF_8))
        );
        assert_eq!(
            Charset::for_label(b"  iSo-8859-1\t "),
            Some(Charset::for_encoding(encoding_rs::WINDOWS_1252))
        );
        assert_eq!(
            Charset::for_label(b"  gb2312\t "),
            Some(Charset::for_encoding(encoding_rs::GB18030))
        );
        assert_eq!(
            Charset::for_label(b"  ISO-2022-KR\t "),
            Some(Charset::for_encoding(encoding_rs::REPLACEMENT))
        );

        assert_eq!(Charset::for_label(b"u"), None);
        assert_eq!(Charset::for_label(b"ut"), None);
        assert_eq!(Charset::for_label(b"utf"), None);
        assert_eq!(Charset::for_label(b"utf-"), None);
    }

    #[test]
    fn test_for_label_no_replacement() {
        assert_eq!(
            Charset::for_label_no_replacement(b"  uTf-7\t "),
            Some(UTF_7)
        );
        assert_eq!(
            Charset::for_label_no_replacement(b"  uTf-8\t "),
            Some(Charset::for_encoding(encoding_rs::UTF_8))
        );
        assert_eq!(
            Charset::for_label_no_replacement(b"  iSo-8859-1\t "),
            Some(Charset::for_encoding(encoding_rs::WINDOWS_1252))
        );
        assert_eq!(
            Charset::for_label_no_replacement(b"  Gb2312\t "),
            Some(Charset::for_encoding(encoding_rs::GB18030))
        );
        assert_eq!(Charset::for_label_no_replacement(b"  ISO-2022-KR\t "), None);

        assert_eq!(Charset::for_label_no_replacement(b"u"), None);
        assert_eq!(Charset::for_label_no_replacement(b"ut"), None);
        assert_eq!(Charset::for_label_no_replacement(b"utf"), None);
        assert_eq!(Charset::for_label_no_replacement(b"utf-"), None);
    }

    #[test]
    fn test_for_label_and_name() {
        assert_eq!(Charset::for_label(b"  uTf-7\t ").unwrap().name(), "UTF-7");
        assert_eq!(Charset::for_label(b"  uTf-8\t ").unwrap().name(), "UTF-8");
        assert_eq!(
            Charset::for_label(b"  Gb2312\t ").unwrap().name(),
            "gb18030"
        );
    }

    #[test]
    fn test_extended_labels() {
        let cases: [(&'static str, VariantCharset); 29] = [
            (
                "iso8859_1",
                VariantCharset::Encoding(&encoding_rs::WINDOWS_1252_INIT),
            ),
            (
                "iso8859_2",
                VariantCharset::Encoding(&encoding_rs::ISO_8859_2_INIT),
            ),
            (
                "iso8859_3",
                VariantCharset::Encoding(&encoding_rs::ISO_8859_3_INIT),
            ),
            (
                "iso8859_4",
                VariantCharset::Encoding(&encoding_rs::ISO_8859_4_INIT),
            ),
            (
                "iso8859_5",
                VariantCharset::Encoding(&encoding_rs::ISO_8859_5_INIT),
            ),
            (
                "iso8859_6",
                VariantCharset::Encoding(&encoding_rs::ISO_8859_6_INIT),
            ),
            (
                "iso8859_7",
                VariantCharset::Encoding(&encoding_rs::ISO_8859_7_INIT),
            ),
            (
                "iso8859_9",
                VariantCharset::Encoding(&encoding_rs::WINDOWS_1254_INIT),
            ),
            (
                "iso8859_13",
                VariantCharset::Encoding(&encoding_rs::ISO_8859_13_INIT),
            ),
            (
                "iso8859_15",
                VariantCharset::Encoding(&encoding_rs::ISO_8859_15_INIT),
            ),
            (
                "ms936",
                VariantCharset::Encoding(&encoding_rs::GB18030_INIT),
            ),
            ("ms949", VariantCharset::Encoding(&encoding_rs::EUC_KR_INIT)),
            ("ms950", VariantCharset::Encoding(&encoding_rs::BIG5_INIT)),
            (
                "ms950_hkscs",
                VariantCharset::Encoding(&encoding_rs::BIG5_INIT),
            ),
            (
                "ms874",
                VariantCharset::Encoding(&encoding_rs::WINDOWS_874_INIT),
            ),
            (
                "euc_jp",
                VariantCharset::Encoding(&encoding_rs::EUC_JP_INIT),
            ),
            (
                "euc_kr",
                VariantCharset::Encoding(&encoding_rs::EUC_KR_INIT),
            ),
            (
                "euc_cn",
                VariantCharset::Encoding(&encoding_rs::GB18030_INIT),
            ),
            (
                "koi8_r",
                VariantCharset::Encoding(&encoding_rs::KOI8_R_INIT),
            ),
            (
                "koi8_u",
                VariantCharset::Encoding(&encoding_rs::KOI8_U_INIT),
            ),
            (
                "x-windows-874",
                VariantCharset::Encoding(&encoding_rs::WINDOWS_874_INIT),
            ),
            (
                "x-windows-949",
                VariantCharset::Encoding(&encoding_rs::EUC_KR_INIT),
            ),
            (
                "x-windows-950",
                VariantCharset::Encoding(&encoding_rs::BIG5_INIT),
            ),
            (
                "tis620",
                VariantCharset::Encoding(&encoding_rs::WINDOWS_874_INIT),
            ),
            (
                "iso2022jp",
                VariantCharset::Encoding(&encoding_rs::ISO_2022_JP_INIT),
            ),
            ("x-unicode-2-0-utf-7", VariantCharset::Utf7), // Netscape 4.0 per https://jkorpela.fi/chars.html
            ("unicode-1-1-utf-7", VariantCharset::Utf7), // https://www.iana.org/assignments/character-sets/character-sets.xhtml
            ("csunicode11utf7", VariantCharset::Utf7), // https://www.iana.org/assignments/character-sets/character-sets.xhtml
            ("utf-7", VariantCharset::Utf7),
        ];
        for (label, expected) in cases.iter() {
            assert_eq!(
                Charset::for_label(label.as_bytes()),
                Some(Charset { variant: *expected })
            );
        }
    }

    #[test]
    fn test_utf7_decode() {
        assert_eq!(utf7_no_err(b""), "");
        assert_eq!(utf7_no_err(b"ab"), "ab");
        assert_eq!(utf7_no_err(b"+-"), "+");
        assert_eq!(utf7_no_err(b"a+-b"), "a+b");

        assert_eq!(utf7_no_err(b"+ACs-"), "+");
        assert_eq!(utf7_no_err(b"+AGEAKwBi-"), "a+b");

        assert_eq!(utf7_no_err(b"+JgM-"), "\u{2603}");
        assert_eq!(utf7_no_err(b"+JgM."), "\u{2603}.");
        assert_eq!(utf7_no_err(b"+JgM "), "\u{2603} ");
        assert_eq!(utf7_no_err(b"+JgM--"), "\u{2603}-");
        assert_eq!(utf7_no_err(b"+JgM"), "\u{2603}");

        assert_eq!(utf7_no_err(b"+JgMmAw-"), "\u{2603}\u{2603}");
        assert_eq!(utf7_no_err(b"+JgMmAw."), "\u{2603}\u{2603}.");
        assert_eq!(utf7_no_err(b"+JgMmAw "), "\u{2603}\u{2603} ");
        assert_eq!(utf7_no_err(b"+JgMmAw--"), "\u{2603}\u{2603}-");
        assert_eq!(utf7_no_err(b"+JgMmAw"), "\u{2603}\u{2603}");

        assert_eq!(utf7_no_err(b"+2D3cqQ-"), "\u{1F4A9}");
        assert_eq!(utf7_no_err(b"+2D3cqQ."), "\u{1F4A9}.");
        assert_eq!(utf7_no_err(b"+2D3cqQ "), "\u{1F4A9} ");
        assert_eq!(utf7_no_err(b"+2D3cqQ--"), "\u{1F4A9}-");
        assert_eq!(utf7_no_err(b"+2D3cqQ"), "\u{1F4A9}");

        assert_eq!(utf7_no_err(b"+JgPYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp2D3cqdg93KnYPdyp"), "\u{2603}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}\u{1F4A9}");

        assert_eq!(utf7_err(b"+"), "\u{FFFD}");

        assert_eq!(utf7_err(b"+J-"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+Jg-"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+J"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+Jg"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+."), "\u{FFFD}.");
        assert_eq!(utf7_err(b"+J."), "\u{FFFD}.");
        assert_eq!(utf7_err(b"+Jg."), "\u{FFFD}.");
        assert_eq!(utf7_err(b"+ "), "\u{FFFD} ");
        assert_eq!(utf7_err(b"+J "), "\u{FFFD} ");
        assert_eq!(utf7_err(b"+Jg "), "\u{FFFD} ");

        assert_eq!(utf7_err(b"+JgMmA-"), "\u{2603}\u{FFFD}\u{FFFD}");
        assert_eq!(utf7_err(b"+JgMmA"), "\u{2603}\u{FFFD}\u{FFFD}");
        assert_eq!(utf7_err(b"+JgMmA."), "\u{2603}\u{FFFD}\u{FFFD}.");
        assert_eq!(utf7_err(b"+JgMmA "), "\u{2603}\u{FFFD}\u{FFFD} ");

        assert_eq!(utf7_err(b"+JgMm-"), "\u{2603}\u{FFFD}");
        assert_eq!(utf7_err(b"+JgMm"), "\u{2603}\u{FFFD}");
        assert_eq!(utf7_err(b"+JgMm."), "\u{2603}\u{FFFD}.");
        assert_eq!(utf7_err(b"+JgMm "), "\u{2603}\u{FFFD} ");

        assert_eq!(utf7_err(b"+2D3cq-"), "\u{FFFD}\u{FFFD}");
        assert_eq!(utf7_err(b"+2D3cq"), "\u{FFFD}\u{FFFD}");
        assert_eq!(utf7_err(b"+2D3cq."), "\u{FFFD}\u{FFFD}.");
        assert_eq!(utf7_err(b"+2D3cq "), "\u{FFFD}\u{FFFD} ");

        assert_eq!(utf7_err(b"+2D3c-"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2D3c"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2D3c."), "\u{FFFD}.");
        assert_eq!(utf7_err(b"+2D3c "), "\u{FFFD} ");

        assert_eq!(utf7_err(b"+2D3-"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2D3"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2D3."), "\u{FFFD}.");
        assert_eq!(utf7_err(b"+2D3 "), "\u{FFFD} ");

        assert_eq!(utf7_err(b"+2D-"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2D"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2D."), "\u{FFFD}.");
        assert_eq!(utf7_err(b"+2D "), "\u{FFFD} ");

        assert_eq!(utf7_err(b"+2-"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2."), "\u{FFFD}.");
        assert_eq!(utf7_err(b"+2 "), "\u{FFFD} ");

        // Lone high surrogate
        assert_eq!(utf7_err(b"+2D0-"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2D0"), "\u{FFFD}");
        assert_eq!(utf7_err(b"+2D0."), "\u{FFFD}.");
        assert_eq!(utf7_err(b"+2D0 "), "\u{FFFD} ");

        assert_eq!(utf7_err(b"+2D0AYQ-"), "\u{FFFD}a");
        assert_eq!(utf7_err(b"+2D0AYQ"), "\u{FFFD}a");
        assert_eq!(utf7_err(b"+2D0AYQ."), "\u{FFFD}a.");
        assert_eq!(utf7_err(b"+2D0AYQ "), "\u{FFFD}a ");

        assert_eq!(utf7_err(b"+2D3/QQ-"), "\u{FFFD}\u{FF41}");
        assert_eq!(utf7_err(b"+2D3/QQ"), "\u{FFFD}\u{FF41}");
        assert_eq!(utf7_err(b"+2D3/QQ."), "\u{FFFD}\u{FF41}.");
        assert_eq!(utf7_err(b"+2D3/QQ "), "\u{FFFD}\u{FF41} ");

        // Lone low surrogate
        assert_eq!(utf7_err(b"+AGHcqQ-"), "a\u{FFFD}");
        assert_eq!(utf7_err(b"+AGHcqQ"), "a\u{FFFD}");
        assert_eq!(utf7_err(b"+AGHcqQ."), "a\u{FFFD}.");
        assert_eq!(utf7_err(b"+AGHcqQ "), "a\u{FFFD} ");
    }

    #[test]
    fn test_decode_ascii() {
        assert_eq!(decode_ascii(b"aa\x80bb\xFFcc"), "aa\u{FFFD}bb\u{FFFD}cc");
    }

    #[test]
    fn test_from() {
        let _: Charset = encoding_rs::UTF_8.into();
    }

    #[cfg(feature = "serde")]
    #[test]
    fn test_serde_utf7() {
        let demo = Demo {
            num: 42,
            name: "foo".into(),
            charset: UTF_7,
        };

        let serialized = serde_json::to_string(&demo).unwrap();

        let deserialized: Demo = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, demo);

        let bincoded = bincode::serialize(&demo).unwrap();
        let debincoded: Demo = bincode::deserialize(&bincoded[..]).unwrap();
        assert_eq!(debincoded, demo);
    }

    #[cfg(feature = "serde")]
    #[test]
    fn test_serde_utf8() {
        let demo = Demo {
            num: 42,
            name: "foo".into(),
            charset: encoding_rs::UTF_8.into(),
        };

        let serialized = serde_json::to_string(&demo).unwrap();

        let deserialized: Demo = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, demo);

        let bincoded = bincode::serialize(&demo).unwrap();
        let debincoded: Demo = bincode::deserialize(&bincoded[..]).unwrap();
        assert_eq!(debincoded, demo);
    }
}
