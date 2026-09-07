//! # Functions to unescape HTML into raw text
//!
//! See the normative reference for HTML5 entities:
//! <https://html.spec.whatwg.org/multipage/named-characters.html#named-character-references>
//!
//! Entities do not always require a trailing semicolon, though the exact rules
//! depend on whether the entity appears in an attribute value or somewhere else.
//! See [`unescape_in()`] for more information.
//!
//! Some entities are prefixes for multiple other entities. For example:
//!   &times &times; &timesb; &timesbar; &timesd;
//!
//! ### _fast and _slow
//!
//! This builds _fast and _slow versions of all functions depending on the
//! enabled features. When all features are enabled, it uses the _fast versions
//! in the public API, but it still builds the slow versions so that all
//! functions can be tested.

use pastey::paste;
use std::borrow::Cow;
use std::char;
use std::num::IntErrorKind;
use std::result::Result;
use std::slice;

/// The context for an input string.
///
/// See [`unescape_in()`] for usage.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Context {
    /// Anywhere outside of an HTML attribute, e.g. regular text. This is
    /// generally what you want.
    General,
    /// From an HTML attribute.
    Attribute,
}

/// Call the correct internal version of the unescape function (_fast or _slow).
/// See “_fast and _slow” heading in the comment at the top of this file.
macro_rules! call_unescape {
    ($function:ident($($args:expr),+)) => {
        paste! {
            #[cfg(feature = "unescape_fast")]
            return [<$function _fast>]($($args),+);

            #[cfg(all(feature = "unescape", not(feature = "unescape_fast")))]
            return [<$function _slow>]($($args),+);
        }
    }
}

/// Expand all valid entities.
///
/// This is appropriate to use on any text outside of an attribute. See
/// [`unescape_in()`] for more information.
///
/// To work with bytes (`[u8]`) instead of strings, see [`unescape_bytes_in()`].
pub fn unescape<'a, S: Into<Cow<'a, str>>>(escaped: S) -> Cow<'a, str> {
    call_unescape!(unescape_in(escaped, Context::General));
}

/// Expand all valid entities in an attribute.
///
/// This is only appropriate for the value of an attribute. See
/// [`unescape_in()`] for more information.
///
/// To work with bytes (`[u8]`) instead of strings, see [`unescape_bytes_in()`].
pub fn unescape_attribute<'a, S: Into<Cow<'a, str>>>(
    escaped: S,
) -> Cow<'a, str> {
    call_unescape!(unescape_in(escaped, Context::Attribute));
}

/// Expand all valid entities in a given context.
///
/// `context` may be:
///
///   * `Context::General`: use the rules for text outside of an attribute.
///     This is usually what you want.
///   * `Context::Attribute`: use the rules for attribute values.
///
/// This uses the [algorithm described] in the WHATWG spec. In attributes,
/// [named entities] without trailing semicolons are treated differently. They
/// not expanded if they are followed by an alphanumeric character or or `=`.
///
/// For example:
///
/// ```rust
/// use htmlize::*;
/// # use assert2::check as assert;
///
/// assert!(unescape_in("&times",   Context::General)   == "×");
/// assert!(unescape_in("&times",   Context::Attribute) == "×");
/// assert!(unescape_in("&times;X", Context::General)   == "×X");
/// assert!(unescape_in("&times;X", Context::Attribute) == "×X");
/// assert!(unescape_in("&timesX",  Context::General)   == "×X");
/// assert!(unescape_in("&timesX",  Context::Attribute) == "&timesX");
/// assert!(unescape_in("&times=",  Context::General)   == "×=");
/// assert!(unescape_in("&times=",  Context::Attribute) == "&times=");
/// assert!(unescape_in("&times#",  Context::General)   == "×#");
/// assert!(unescape_in("&times#",  Context::Attribute) == "×#");
/// ```
///
/// To work with bytes (`[u8]`) instead of strings, see [`unescape_bytes_in()`].
///
/// [algorithm described]: https://html.spec.whatwg.org/multipage/parsing.html#character-reference-state
/// [named entities]: https://html.spec.whatwg.org/multipage/parsing.html#named-character-reference-state
pub fn unescape_in<'a, S: Into<Cow<'a, str>>>(
    escaped: S,
    context: Context,
) -> Cow<'a, str> {
    call_unescape!(unescape_in(escaped, context));
}

/// Expand all valid entities in a given context.
///
/// `context` may be:
///
///   * `Context::General`: use the rules for text outside of an attribute.
///     This is usually what you want.
///   * `Context::Attribute`: use the rules for attribute values.
///
/// This uses the [algorithm described] in the WHATWG spec. In attributes,
/// [named entities] without trailing semicolons are treated differently. They
/// not expanded if they are followed by an alphanumeric character or or `=`.
///
/// For example:
///
/// ```rust
/// use htmlize::*;
/// # use assert2::check as assert;
///
/// assert!(unescape_bytes_in(&b"&times"[..],   Context::General)   == "×".as_bytes());
/// assert!(unescape_bytes_in(&b"&times"[..],   Context::Attribute) == "×".as_bytes());
/// assert!(unescape_bytes_in(&b"&times;X"[..], Context::General)   == "×X".as_bytes());
/// assert!(unescape_bytes_in(&b"&times;X"[..], Context::Attribute) == "×X".as_bytes());
/// assert!(unescape_bytes_in(&b"&timesX"[..],  Context::General)   == "×X".as_bytes());
/// assert!(unescape_bytes_in(&b"&timesX"[..],  Context::Attribute) == "&timesX".as_bytes());
/// assert!(unescape_bytes_in(&b"&times="[..],  Context::General)   == "×=".as_bytes());
/// assert!(unescape_bytes_in(&b"&times="[..],  Context::Attribute) == "&times=".as_bytes());
/// assert!(unescape_bytes_in(&b"&times#"[..],  Context::General)   == "×#".as_bytes());
/// assert!(unescape_bytes_in(&b"&times#"[..],  Context::Attribute) == "×#".as_bytes());
/// ```
///
/// To work with `String` instead of bytes, see [`unescape_in()`].
///
/// [algorithm described]: https://html.spec.whatwg.org/multipage/parsing.html#character-reference-state
/// [named entities]: https://html.spec.whatwg.org/multipage/parsing.html#named-character-reference-state
pub fn unescape_bytes_in<'a, S: Into<Cow<'a, [u8]>>>(
    escaped: S,
    context: Context,
) -> Cow<'a, [u8]> {
    call_unescape!(unescape_bytes_in(escaped, context));
}

/// Generate the _fast and _slow version of the unescape functions.
///
/// See “_fast and _slow” heading in the comment at the top of this file.
///
/// `#[allow(dead_code)]` is required to avoid false positive lints. Every
/// function is used in tests.
macro_rules! unescape_fns {
    ($vis:vis $suffix:ident) => {
        paste! {
            /// See [`unescape()`].
            #[allow(dead_code)]
            #[inline]
            $vis fn [<unescape $suffix>]<'a, S: Into<Cow<'a, str>>>(
                escaped: S,
            ) -> Cow<'a, str> {
                [<unescape_in $suffix>](escaped, Context::General)
            }

            /// See [`unescape_attribute()`].
            #[allow(dead_code)]
            #[inline]
            $vis fn [<unescape_attribute $suffix>]<'a, S: Into<Cow<'a, str>>>(
                escaped: S,
            ) -> Cow<'a, str> {
                [<unescape_in $suffix>](escaped, Context::Attribute)
            }

            /// See [`unescape_in()`].
            #[inline]
            $vis fn [<unescape_in $suffix>]<'a, S: Into<Cow<'a, str>>>(
                escaped: S,
                context: Context,
            ) -> Cow<'a, str> {
                let escaped = escaped.into();
                let bytes = escaped.as_bytes();
                match [<unescape_in_internal $suffix>](bytes, context) {
                    Some(buffer) => String::from_utf8(buffer).unwrap().into(),
                    None => escaped,
                }
            }

            /// See [`unescape_bytes_in()`].
            #[inline]
            $vis fn [<unescape_bytes_in $suffix>]<'a, S: Into<Cow<'a, [u8]>>>(
                escaped: S,
                context: Context,
            ) -> Cow<'a, [u8]> {
                let escaped = escaped.into();
                match [<unescape_in_internal $suffix>](&escaped, context) {
                    Some(buffer) => buffer.into(),
                    None => escaped,
                }
            }

            #[inline(always)]
            fn [<unescape_in_internal $suffix>](
                escaped: &[u8],
                context: Context,
            ) -> Option<Vec<u8>> {
                let mut remainder = escaped;
                let mut iter = remainder.iter();

                while advance_until(&mut iter, |&c| c == b'&') {
                    // `iter` was generated from `remainder`, so
                    // `iter.as_slice().len()` will always be less than or equal
                    // to `remainder.len()`.
                    debug_assert!(remainder.len() >= iter.as_slice().len());
                    #[allow(clippy::arithmetic_side_effects)]
                    let i = remainder.len() - iter.as_slice().len();

                    if let Some(expansion) = [<match_entity $suffix>](&mut iter, context) {
                        // All but two entities are as long or longer than their
                        // expansion, so allocating the output buffer to be the
                        // same size as the input will usually prevent multiple
                        // allocations and generally won’t over-allocate by very
                        // much.
                        //
                        // The two entities are `&nGg;` (≫⃒) and `&nLl;` (≪⃒)
                        // which are both five byte entities with six byte
                        // expansions.
                        let mut buffer = Vec::with_capacity(escaped.len());

                        buffer.extend_from_slice(&remainder[..i]);
                        buffer.extend_from_slice(&expansion);
                        remainder = iter.as_slice();

                        while advance_until(&mut iter, |&c| c == b'&') {
                            // `remainder` was generated from `iter` before
                            // `iter` was advanced, so `iter.as_slice()` will
                            // always be shorter than or equal to `remainder`.
                            debug_assert!(remainder.len() >= iter.as_slice().len());
                            #[allow(clippy::arithmetic_side_effects)]
                            let i = remainder.len() - iter.as_slice().len();

                            if let Some(expansion) = [<match_entity $suffix>](&mut iter, context) {
                                buffer.extend_from_slice(&remainder[..i]);
                                buffer.extend_from_slice(&expansion);
                                remainder = iter.as_slice();
                            }
                        }

                        buffer.extend_from_slice(remainder);
                        return Some(buffer);
                    }
                }

                None
            }
        }
    }
}

// Need these to be public for benchmarks
#[cfg(all(feature = "unescape_fast", feature = "bench", not(doc)))]
unescape_fns!(pub _fast);

// Need these to be public for benchmarks
#[cfg(all(feature = "unescape", feature = "bench", not(doc)))]
unescape_fns!(pub _slow);

#[cfg(all(feature = "unescape_fast", not(feature = "bench")))]
unescape_fns!(_fast);

#[cfg(all(feature = "unescape", not(feature = "bench")))]
unescape_fns!(_slow);

// Include function to match entities at the start of an iterator. Used in
// `match_entity()`.
//
// fn entity_matcher<'a, I>(iter: &mut I) -> Option<(bool, &'static [u8])>
// where
//     I: Iterator<Item = &'a u8> + Clone,
#[cfg(feature = "unescape_fast")]
include!(concat!(env!("OUT_DIR"), "/matcher.rs"));

/// Match an entity at the beginning of `iter`. Either:
///
///   * It finds a match: returns `Some(expansion)` and `iter` is updated to
///     point to the next character after the entity.
///   * It doesn’t find a match: returns `None` and `iter` is updated to point
///     to the next character than could plausibly start an entity (not
///     necessarily b'&', though; the only gaurantee is that we didn’t skip a
///     potential entity).
///
/// This version uses matchgen instead of the `ENTITIES` map. It is faster at
/// runtime but slower to build.
#[cfg(feature = "unescape_fast")]
fn match_entity_fast<'a>(
    iter: &'a mut slice::Iter<u8>,
    context: Context,
) -> Option<Cow<'a, [u8]>> {
    assert_peek_eq(iter, Some(b'&'), "match_entity() expected '&'");

    if Some(b'#') == peek_n(iter, 1) {
        // Numeric entity.
        return match_numeric_entity(iter);
    }

    if context == Context::Attribute {
        // In an attribute entities ending with an alphanumeric character or '='
        // instead of ';' are passed through without expansion.
        //
        // See `unescape_in()` documentation for examples.
        //
        // https://html.spec.whatwg.org/multipage/parsing.html#named-character-reference-state
        if let Some((closed, expansion)) = entity_matcher(iter) {
            if !closed {
                if let Some(next) = peek(iter) {
                    if next == b'=' || next.is_ascii_alphanumeric() {
                        return None;
                    }
                }
            }

            Some(expansion.into())
        } else {
            // Move past initial b'&'.
            iter.next();
            None
        }
    } else {
        entity_matcher(iter)
            .map(|(_, expansion)| expansion.into())
            .or_else(|| {
                // No match; move past initial b'&'.
                iter.next();
                None
            })
    }
}

/// A panic message we use repeatedly.
const PEEK_MATCH_ERROR: &str = "iter.next() did not match previous peek(iter)";

/// Match an entity at the beginning of `iter`. Either:
///
///   * It finds a match: returns `Some(expansion)` and `iter` is updated to
///     point to the next character after the entity.
///   * It doesn’t find a match: returns `None` and `iter` is updated to point
///     to the next character than could plausibly start an entity (not
///     necessarily b'&', though; the only gaurantee is that we didn’t skip a
///     potential entity).
///
/// This version uses the [`ENTITIES`] map instead of matchgen. It is slower at
/// runtime but faster to build.
///
/// [`ENTITIES`]: crate::ENTITIES
#[cfg(feature = "unescape")]
fn match_entity_slow<'a>(
    iter: &'a mut slice::Iter<u8>,
    context: Context,
) -> Option<Cow<'a, [u8]>> {
    use crate::{ENTITIES, ENTITY_MAX_LENGTH, ENTITY_MIN_LENGTH};
    use std::cmp::min;

    assert_peek_eq(iter, Some(b'&'), "match_entity() expected '&'");

    if Some(b'#') == peek_n(iter, 1) {
        // Numeric entity.
        return match_numeric_entity(iter);
    }

    // Create a second iter because we need to look ahead to find the longest
    // matching entity. We’ll update the original iter before we return.
    let mut candidate_iter = iter.clone();
    assert_next_eq(&mut candidate_iter, Some(b'&'), PEEK_MATCH_ERROR);

    // Determine longest possible candidate. (Start at 1 since we got the '&'.)
    for _ in 1..ENTITY_MAX_LENGTH {
        if let Some(c) = peek(&candidate_iter) {
            if c.is_ascii_alphanumeric() {
                candidate_iter.next();
                continue;
            }
        }

        break;
    }

    match peek(&candidate_iter) {
        Some(b';') => {
            // Actually consume the semicolon.
            assert_next_eq(&mut candidate_iter, Some(b';'), PEEK_MATCH_ERROR);
        }
        Some(b'=') if context == Context::Attribute => {
            // In an attribute entities ending with an alphanumeric character or
            // '=' instead of ';' are passed through without expansion.
            //
            // See `unescape_in()` documentation for examples.
            //
            // Alphanumeric characters don’t matter here because either:
            //
            //   * The loop above consumed ENTITY_MAX_LENGTH-1 alphanumeric
            //     characters, so it can’t match an entity because it didn’t
            //     find a ';' (the longest entity ends with a ';').
            //   * The loop above consumer fewer than ENTITY_MAX_LENGTH-1
            //     alphanumeric characters, so the next character cannot be
            //     alphanumeric.
            //
            // (The longest entity will always end with a ';' since any bare
            // entity will always have a closed version with a trailing
            // semicolon, which by definition will be longer.)
            //
            // https://html.spec.whatwg.org/multipage/parsing.html#named-character-reference-state
            *iter = candidate_iter;
            return None;
        }
        _ => {
            // missing-semicolon-after-character-reference: ignore and continue.
            // https://html.spec.whatwg.org/multipage/parsing.html#parse-error-missing-semicolon-after-character-reference
        }
    }

    let raw = &iter.as_slice();

    // Both `raw` and `candidate_iter` were generated from `iter`, then
    // `candidate_iter` was advanced, so `candidate_iter.as_slice().len()` will
    // always be less than `raw.len()`.
    debug_assert!(raw.len() >= candidate_iter.as_slice().len());
    #[allow(clippy::arithmetic_side_effects)]
    let candidate = &raw[..raw.len() - candidate_iter.as_slice().len()];

    if candidate.len() < ENTITY_MIN_LENGTH {
        // Couldn’t possibly match. Don’t expand.
        *iter = candidate_iter;
        return None;
    }

    if context == Context::Attribute {
        // If candidate does not exactly match an entity, then don't expand it.
        // The spec says that entities  *in attributes* must be terminated with
        // a semicolon, EOF, or some character *other* than [a-zA-Z0-9=].
        //
        // See `unescape_in()` documentation for examples.
        //
        // https://html.spec.whatwg.org/multipage/parsing.html#named-character-reference-state
        if let Some(&expansion) = ENTITIES.get(candidate) {
            *iter = candidate_iter;
            return Some(expansion.into());
        }
    } else {
        // Find longest matching entity.
        let max_len = min(candidate.len(), ENTITY_MAX_LENGTH);
        for check_len in (ENTITY_MIN_LENGTH..=max_len).rev() {
            if let Some(&expansion) = ENTITIES.get(&candidate[..check_len]) {
                // Found a match. check_len starts at ENTITY_MIN_LENGTH, which
                // must always be greater than 0, so `check_len - 1` is safe.
                debug_assert!(check_len >= 1);
                #[allow(clippy::arithmetic_side_effects)]
                iter.nth(check_len - 1); // Update iter. nth(0) == next().
                return Some(expansion.into());
            }
        }
    }

    // Did not find a match.
    *iter = candidate_iter;
    None
}

/// Match a numeric entity like `&#x20;` or `&#32;`.
#[allow(clippy::from_str_radix_10)]
fn match_numeric_entity(
    iter: &mut slice::Iter<u8>,
) -> Option<Cow<'static, [u8]>> {
    assert_next_eq(iter, Some(b'&'), "match_numeric_entity() expexted '&'");
    assert_next_eq(iter, Some(b'#'), "match_numeric_entity() expexted '#'");

    let number = match peek(iter) {
        c @ Some(b'x' | b'X') => {
            // Hexadecimal entity
            assert_next_eq(iter, c, PEEK_MATCH_ERROR);

            let hex = slice_while(iter, u8::is_ascii_hexdigit);
            u32::from_str_radix(core::str::from_utf8(hex).unwrap(), 16)
        }
        Some(_) => {
            // Presumably a decimal entity
            let dec = slice_while(iter, u8::is_ascii_digit);
            u32::from_str_radix(core::str::from_utf8(dec).unwrap(), 10)
        }
        None => {
            // Iterator reached end; do not expand.
            return None;
        }
    };

    if Some(b';') == peek(iter) {
        assert_next_eq(iter, Some(b';'), PEEK_MATCH_ERROR);
    } else {
        // missing-semicolon-after-character-reference: ignore and continue.
        // https://html.spec.whatwg.org/multipage/parsing.html#parse-error-missing-semicolon-after-character-reference
    }

    match number {
        Ok(number) => {
            return Some(correct_numeric_entity(number));
        }
        Err(error) => match error.kind() {
            IntErrorKind::PosOverflow => {
                // Too large a number
                return Some(REPLACEMENT_CHAR_BYTES.into());
            }
            IntErrorKind::Empty => {
                // No number, e.g. &#; or &#x;. Fall through.
            }
            // Pretty sure this is impossible.
            _ => panic!("error parsing number in numeric entity: {error:?}"),
        },
    }

    // Do not expand.
    None
}

/// Unicode replacement character (U+FFFD, “�”).
///
/// According to the WHATWG HTML spec, this is used as an expansion for certain
/// invalid numeric entities.
///
/// According to Unicode 12, this is “used to replace an incoming character
/// whose value is unknown or unrepresentable in Unicode.” The latest chart for
/// the Specials block is [available as a PDF](https://www.unicode.org/charts/PDF/UFFF0.pdf).
pub const REPLACEMENT_CHAR_BYTES: &[u8] = "\u{fffd}".as_bytes();

/// Calculate the expansion for a numeric entity (after parsing it).
///
/// See <https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state>
#[allow(clippy::match_same_arms)]
fn correct_numeric_entity(number: u32) -> Cow<'static, [u8]> {
    match number {
        // null-character-reference parse error:
        0x00 => REPLACEMENT_CHAR_BYTES.into(),

        // character-reference-outside-unicode-range parse error:
        0x11_0000.. => REPLACEMENT_CHAR_BYTES.into(),

        // https://infra.spec.whatwg.org/#surrogate
        // surrogate-character-reference parse error:
        0xD800..=0xDFFF => REPLACEMENT_CHAR_BYTES.into(),

        // control-character-reference parse error exceptions:
        0x80 => "\u{20AC}".as_bytes().into(), // EURO SIGN (€)
        0x82 => "\u{201A}".as_bytes().into(), // SINGLE LOW-9 QUOTATION MARK (‚)
        0x83 => "\u{0192}".as_bytes().into(), // LATIN SMALL LETTER F WITH HOOK (ƒ)
        0x84 => "\u{201E}".as_bytes().into(), // DOUBLE LOW-9 QUOTATION MARK („)
        0x85 => "\u{2026}".as_bytes().into(), // HORIZONTAL ELLIPSIS (…)
        0x86 => "\u{2020}".as_bytes().into(), // DAGGER (†)
        0x87 => "\u{2021}".as_bytes().into(), // DOUBLE DAGGER (‡)
        0x88 => "\u{02C6}".as_bytes().into(), // MODIFIER LETTER CIRCUMFLEX ACCENT (ˆ)
        0x89 => "\u{2030}".as_bytes().into(), // PER MILLE SIGN (‰)
        0x8A => "\u{0160}".as_bytes().into(), // LATIN CAPITAL LETTER S WITH CARON (Š)
        0x8B => "\u{2039}".as_bytes().into(), // SINGLE LEFT-POINTING ANGLE QUOTATION MARK (‹)
        0x8C => "\u{0152}".as_bytes().into(), // LATIN CAPITAL LIGATURE OE (Œ)
        0x8E => "\u{017D}".as_bytes().into(), // LATIN CAPITAL LETTER Z WITH CARON (Ž)
        0x91 => "\u{2018}".as_bytes().into(), // LEFT SINGLE QUOTATION MARK (‘)
        0x92 => "\u{2019}".as_bytes().into(), // RIGHT SINGLE QUOTATION MARK (’)
        0x93 => "\u{201C}".as_bytes().into(), // LEFT DOUBLE QUOTATION MARK (“)
        0x94 => "\u{201D}".as_bytes().into(), // RIGHT DOUBLE QUOTATION MARK (”)
        0x95 => "\u{2022}".as_bytes().into(), // BULLET (•)
        0x96 => "\u{2013}".as_bytes().into(), // EN DASH (–)
        0x97 => "\u{2014}".as_bytes().into(), // EM DASH (—)
        0x98 => "\u{02DC}".as_bytes().into(), // SMALL TILDE (˜)
        0x99 => "\u{2122}".as_bytes().into(), // TRADE MARK SIGN (™)
        0x9A => "\u{0161}".as_bytes().into(), // LATIN SMALL LETTER S WITH CARON (š)
        0x9B => "\u{203A}".as_bytes().into(), // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK (›)
        0x9C => "\u{0153}".as_bytes().into(), // LATIN SMALL LIGATURE OE (œ)
        0x9E => "\u{017E}".as_bytes().into(), // LATIN SMALL LETTER Z WITH CARON (ž)
        0x9F => "\u{0178}".as_bytes().into(), // LATIN CAPITAL LETTER Y WITH DIAERESIS (Ÿ)

        // A few parse errors and other cases are handled by the catch-all.
        //
        //   * noncharacter-character-reference parse error
        //   * control-character-reference parse error
        //   * 0x0d (carriage return)
        //   * ASCII whitespace
        //   * ASCII control characters
        //
        // I found the spec a little confusing here, but a close reading and
        // some browser testing convinced me that all of these cases are handled
        // but just emitting the represented code point.

        // Everything else.
        c => char::from_u32(c)
            .map(|c| c.to_string().into_bytes().into())
            // Should never fall back since we handle all the cases above.
            .unwrap_or_else(|| REPLACEMENT_CHAR_BYTES.into()),
    }
}

/// Advance `iter` until `predicate` returns `true`.
///
/// This leaves `iter` pointing to the entry _before_ the one `predicate` found.
/// In other words, `iter.next()` will return the one `predicate` found next.
///
/// Returns `true` if there is more `iter` to consume and `false` if `iter` is
/// used up.
#[inline]
fn advance_until<P>(iter: &mut slice::Iter<u8>, mut predicate: P) -> bool
where
    P: FnMut(&u8) -> bool,
{
    for c in iter.as_slice() {
        if predicate(c) {
            return true;
        }
        iter.next();
    }

    false
}

/// Advance iterator while `predicate` matches (`next()` will return the first
/// byte that doesn’t match) and return a slice of the bytes that didn’t match.
#[inline]
fn slice_while<'a, P>(
    iter: &mut slice::Iter<'a, u8>,
    mut predicate: P,
) -> &'a [u8]
where
    P: FnMut(&u8) -> bool,
{
    slice_until(iter, move |c| !predicate(c))
}

/// Advance iterator until the byte _before_ `predicate` matches and return a
/// slice of the bytes matched.
#[inline]
fn slice_until<'a, P>(iter: &mut slice::Iter<'a, u8>, predicate: P) -> &'a [u8]
where
    P: FnMut(&u8) -> bool,
{
    let remainder = iter.as_slice();
    position_peek(iter, predicate)
        .map(|i| &remainder[..i])
        .unwrap_or(remainder)
}

/// Move to the next value in `iter` and assert that it equals `expected`.
#[inline]
fn assert_next_eq(iter: &mut slice::Iter<u8>, expected: Option<u8>, msg: &str) {
    assert_eq!(iter.next().copied(), expected, "{msg}");
}

/// Peek the next value in `iter` and assert that it equals `expected`.
#[inline]
fn assert_peek_eq(iter: &slice::Iter<u8>, expected: Option<u8>, msg: &str) {
    assert_eq!(peek(iter), expected, "{msg}");
}

/// Peek at the next value in `iter` without changing the `iter`.
#[inline]
fn peek(iter: &slice::Iter<u8>) -> Option<u8> {
    peek_n(iter, 0)
}

/// Peek at a future value in `iter` without changing the `iter`.
#[inline]
fn peek_n(iter: &slice::Iter<u8>, n: usize) -> Option<u8> {
    iter.as_slice().get(n).copied()
}

/// Like `position()`, but stops _before_ the found value.
#[inline]
fn position_peek<P>(
    iter: &mut slice::Iter<u8>,
    mut predicate: P,
) -> Option<usize>
where
    P: FnMut(&u8) -> bool,
{
    try_fold_peek(iter, 0, move |i, x| {
        if predicate(x) {
            Err(i)
        } else {
            // `i` counts items in a slice, so it can never be `usize::MAX`. If
            // there were `usize::MAX` items, then the last item would be
            // `usize::MAX - 1`, and this would return `Ok(usize::MAX)`.
            debug_assert!(i < usize::MAX);
            #[allow(clippy::arithmetic_side_effects)]
            Ok(i + 1)
        }
    })
    .err()
}

/// Like `try_fold()`, but stops _before_ the found value.
///
/// The passed function should return `Ok(_)` to continue to next value, or
/// `Err(_)` to stop with the iterator pointing at the previous value — i.e. the
/// next call to `iter.next()` will return the value currently being processed.
///
/// This uses `&u8` instead of `u8` so that you can pass `u8::is_ascii_digit` as
/// a predicate to `position_peek()` and friends.
#[inline]
fn try_fold_peek<T, F>(
    iter: &mut slice::Iter<u8>,
    initial: T,
    mut function: F,
) -> Result<T, T>
where
    F: FnMut(T, &u8) -> Result<T, T>,
{
    let mut accumulator = initial;
    for c in iter.as_slice() {
        accumulator = function(accumulator, c)?;
        iter.next();
    }
    Ok(accumulator)
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert2::assert;
    use pastey::paste;

    // Test fast and slow versions of a function.
    macro_rules! test {
        ($name:ident, $function:ident $($test:tt)+) => {
            paste! {
                #[cfg(feature = "unescape_fast")]
                #[test]
                fn [<fast_ $name>]() {
                    assert!([<$function _fast>]$($test)+);
                }

                #[cfg(feature = "unescape")]
                #[test]
                fn [<slow_ $name>]() {
                    assert!([<$function _slow>]$($test)+);
                }
            }
        };
    }

    // Test fast and slow versions of unescape and unescape_attribute.
    macro_rules! test_both {
        ($name:ident, unescape $($test:tt)+) => {
            paste! {
                test!($name, unescape$($test)+);
                test!([<attribute_ $name>], unescape_attribute$($test)+);
            }
        };
    }

    test_both!(almost_entity, unescape("&time") == "&time");
    test_both!(exact_times, unescape("&times;") == "×");
    test_both!(exact_timesb, unescape("&timesb;") == "⊠");
    test_both!(bare_times_end, unescape("&times") == "×");
    test_both!(bare_times_bang, unescape("&times!") == "×!");

    test!(bare_entity_char, unescape("&timesa") == "×a");
    test!(bare_entity_equal, unescape("&times=") == "×=");
    test!(bare_entity_char_semicolon, unescape("&timesa;") == "×a;");
    test!(bare_entity_equal_semicolon, unescape("&times=;") == "×=;");
    test_both!(bare_entity_entity, unescape("&times&lt;") == "×<");
    test!(bare_entity_char_is_prefix, unescape("&timesb") == "×b");
    test!(
        bare_entity_char_is_prefix_entity,
        unescape("&timesb&lt;") == "×b<"
    );
    test!(
        attribute_bare_entity_char,
        unescape_attribute("&timesa") == "&timesa"
    );
    test!(
        attribute_bare_entity_equal,
        unescape_attribute("&times=") == "&times="
    );
    test!(
        attribute_bare_entity_char_semicolon,
        unescape_attribute("&timesa;") == "&timesa;"
    );
    test!(
        attribute_bare_entity_equal_semicolon,
        unescape_attribute("&times=;") == "&times=;"
    );
    test!(
        attribute_bare_entity_char_is_prefix,
        unescape_attribute("&timesb") == "&timesb"
    );
    test!(
        attribute_bare_entity_char_is_prefix_entity,
        unescape_attribute("&timesb&lt;") == "&timesb<"
    );

    test_both!(empty, unescape("") == "");
    test_both!(no_entities, unescape("none") == "none");
    test_both!(only_ampersand, unescape("&") == "&");
    test_both!(empty_entity, unescape("&;") == "&;");
    test_both!(invalid_entity, unescape("&time;") == "&time;");
    test_both!(middle_invalid_entity, unescape(" &time; ") == " &time; ");
    test_both!(
        mixed_valid_invalid_entities,
        unescape("&time; &amp; &time; &amp; &time;")
            == "&time; & &time; & &time;"
    );
    test_both!(middle_entity, unescape(" &amp; ") == " & ");
    test_both!(extra_ampersands, unescape("&&amp;&") == "&&&");
    test_both!(two_entities, unescape("AND &amp;&AMP; and") == "AND && and");
    test_both!(
        long_entity,
        unescape("&aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;")
            == "&aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;"
    );

    test_both!(correct_hex_lowerx_lower, unescape("&#x7a;") == "z");
    test_both!(correct_hex_lowerx_upper, unescape("&#x7A;") == "z");
    test_both!(correct_hex_upperx_lower, unescape("&#X7a;") == "z");
    test_both!(correct_hex_upperx_upper, unescape("&#X7A;") == "z");
    test_both!(correct_hex_leading_zero, unescape("&#x07a;") == "z");
    test_both!(correct_hex_leading_zero_zero, unescape("&#x007a;") == "z");
    test_both!(correct_dec, unescape("&#122;") == "z");
    test_both!(correct_dec_leading_zero, unescape("&#0122;") == "z");
    test_both!(correct_dec_leading_zero_zero, unescape("&#00122;") == "z");
    test_both!(correct_hex_unicode, unescape("&#x21D2;") == "⇒");

    test_both!(bare_hex_char, unescape("&#x7Az") == "zz");
    test_both!(bare_hex_entity, unescape("&#x7A&lt;") == "z<");
    test_both!(bare_hex_end, unescape("&#x7A") == "z");
    test_both!(bare_dec_char, unescape("&#122z") == "zz");
    test_both!(bare_dec_entity, unescape("&#122&lt;") == "z<");
    test_both!(bare_dec_end, unescape("&#122") == "z");
    test_both!(bare_empty_numeric_char, unescape("&#z") == "&#z");
    test_both!(bare_empty_numeric_entity, unescape("&#&lt;") == "&#<");
    test_both!(bare_empty_numeric_end, unescape("&#") == "&#");

    test_both!(hex_instead_of_dec, unescape("&#a0;") == "&#a0;");
    test_both!(invalid_hex_lowerx, unescape("&#xZ;") == "&#xZ;");
    test_both!(invalid_hex_upperx, unescape("&#XZ;") == "&#XZ;");

    test_both!(hex_control_1, unescape("&#x1;") == "\u{1}");
    test_both!(dec_control_1, unescape("&#1;") == "\u{1}");
    test_both!(dec_cr, unescape("&#13;") == "\r");
    test_both!(hex_cr, unescape("&#xd;") == "\r");
    test_both!(hex_tab, unescape("&#9;") == "\t");
    test_both!(dec_tab, unescape("&#9;") == "\t");

    test_both!(hex_max_code_point, unescape("&#x10ffff;") == "\u{10ffff}");
    test_both!(
        hex_above_max_code_point,
        unescape("&#x110001;") == "\u{fffd}"
    );
    test_both!(hex_11_chars, unescape("&#x1100000000;") == "\u{fffd}");
    test_both!(
        bare_hex_11_chars_end,
        unescape("&#x1100000000") == "\u{fffd}"
    );

    test_both!(
        hex_40_chars,
        unescape("&#x110000000000000000000000000000000000000;") == "\u{fffd}"
    );
    test_both!(
        bare_hex_40_chars_end,
        unescape("&#x110000000000000000000000000000000000000") == "\u{fffd}"
    );

    test_both!(special_entity_null, unescape("&#0;") == "\u{fffd}");
    test_both!(special_entity_bullet, unescape("&#x95;") == "•");
    test_both!(
        special_entity_bullets,
        unescape("&#x95;&#149;&#x2022;•") == "••••"
    );
    test_both!(special_entity_space, unescape("&#x20") == " ");

    const ALL_SOURCE: &str =
        include_str!("../tests/corpus/all-entities-source.txt");
    const ALL_EXPANDED: &str =
        include_str!("../tests/corpus/all-entities-expanded.txt");
    test_both!(all_entities, unescape(ALL_SOURCE) == ALL_EXPANDED);

    test!(
        invalid_utf8,
        unescape_bytes_in(&b"\xa1"[..], Context::General) == &b"\xa1"[..]
    );
    test!(
        attribute_invalid_utf8,
        unescape_bytes_in(&b"\xa1"[..], Context::Attribute) == &b"\xa1"[..]
    );

    #[test]
    fn correct_numeric_entity_euro() {
        match correct_numeric_entity(0x80) {
            Cow::Borrowed(s) => assert!(s == "\u{20AC}".as_bytes()),
            Cow::Owned(_) => panic!("expected borrowed"),
        }
    }

    #[test]
    fn correct_numeric_entity_null() {
        match correct_numeric_entity(0) {
            Cow::Borrowed(s) => assert!(s == "\u{fffd}".as_bytes()),
            Cow::Owned(_) => panic!("expected borrowed"),
        }
    }

    #[test]
    fn correct_numeric_entity_z() {
        match correct_numeric_entity(b'z'.into()) {
            Cow::Borrowed(_) => panic!("expected owned"),
            Cow::Owned(ref s) => assert!(s == b"z"),
        }
    }
}
