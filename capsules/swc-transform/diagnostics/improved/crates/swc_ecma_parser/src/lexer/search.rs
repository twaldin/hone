//! Utilities inspired by OXC lexer for fast byte-wise searching over source
//! text.

/// How many bytes we process per batch when scanning.
pub const SEARCH_BATCH_SIZE: usize = 32;

/// Compile-time lookup table guaranteeing UTF-8 boundary safety.
#[repr(C, align(64))]
pub struct SafeByteMatchTable([bool; 256]);

impl SafeByteMatchTable {
    pub const fn new(bytes: [bool; 256]) -> Self {
        // Safety guarantee: either all leading bytes (0xC0..0xF7) match, or all
        // continuation bytes (0x80..0xBF) *do not* match. This ensures that if
        // we stop on a match the input cursor is on a UTF-8 char boundary.
        let mut unicode_start_all_match = true;
        let mut unicode_cont_all_no_match = true;
        let mut i = 0;
        while i < 256 {
            let m = bytes[i];
            if m {
                if i >= 0x80 && i < 0xc0 {
                    unicode_cont_all_no_match = false;
                }
            } else if i >= 0xc0 && i < 0xf8 {
                unicode_start_all_match = false;
            }
            i += 1;
        }
        assert!(
            unicode_start_all_match || unicode_cont_all_no_match,
            "Cannot create SafeByteMatchTable with an unsafe pattern"
        );
        Self(bytes)
    }

    #[inline]
    pub const fn use_table(&self) {}

    #[inline(always)]
    pub fn matches(&self, b: u8) -> bool {
        // Safety: `b` is a byte, so `b as usize` is always within the 256-byte
        // lookup table.
        unsafe { *self.0.get_unchecked(b as usize) }
    }
}

// ------------------------- Macros -------------------------

#[macro_export]
macro_rules! safe_byte_match_table {
    (|$byte:ident| $body:expr) => {{
        use $crate::lexer::search::SafeByteMatchTable;
        #[allow(clippy::eq_op, clippy::allow_attributes)]
        const TABLE: SafeByteMatchTable = seq_macro::seq!($byte in 0u8..=255 {
            SafeByteMatchTable::new([#($body,)*])
        });
        TABLE
    }};
}

#[macro_export]
/// Macro to search for first byte matching a `ByteMatchTable` or
/// `SafeByteMatchTable`.
///
/// Search processes source in batches of `SEARCH_BATCH_SIZE` bytes for speed.
/// When not enough bytes remaining in source for a batch, search source byte by
/// byte.
///
/// The search process is pointer-based and bumps the lexer at the end. So pay
/// attention not to change the pos of lexer in `continue_if`.
macro_rules! byte_search {
    // Simple version without continue_if
    (
        lexer: $lexer:ident,
        table: $table:ident,
        handle_eof: $eof_handler:expr $(,)?
    ) => {
        byte_search! {
            lexer: $lexer,
            table: $table,
            continue_if: (_byte, _pos) false,
            handle_eof: $eof_handler,
        }
    };

    // Variant for callers that know an initial prefix cannot match and want to
    // advance the input only once at the end of the search.
    (
        lexer: $lexer:ident,
        table: $table:ident,
        start_at: $start_at:expr,
        handle_eof: $eof_handler:expr $(,)?
    ) => {
        byte_search! {
            lexer: $lexer,
            table: $table,
            start_at: $start_at,
            continue_if: (_byte, _pos) false,
            handle_eof: $eof_handler,
        }
    };

    // Full version with continue_if support
    (
        lexer: $lexer:ident,
        table: $table:ident,
        continue_if: ($byte:ident, $pos:ident) $should_continue:expr,
        handle_eof: $eof_handler:expr $(,)?
    ) => {
        byte_search! {
            lexer: $lexer,
            table: $table,
            start_at: 0,
            continue_if: ($byte, $pos) $should_continue,
            handle_eof: $eof_handler,
        }
    };

    (
        lexer: $lexer:ident,
        table: $table:ident,
        start_at: $start_at:expr,
        continue_if: ($byte:ident, $pos:ident) $should_continue:expr,
        handle_eof: $eof_handler:expr $(,)?
    ) => {{
        $table.use_table();
        let mut $pos = $start_at;
        let bytes = $lexer.input().as_str().as_bytes();
        let len = bytes.len();
        let bytes = bytes.as_ptr();

        let $byte = 'outer: loop {
            let batch_end = $pos + $crate::lexer::search::SEARCH_BATCH_SIZE;
            let $byte = if batch_end < len {
                'inner: loop {
                    let mut i = 0;
                    while i < $crate::lexer::search::SEARCH_BATCH_SIZE {
                        // Safety: `batch_end < len` and `i < SEARCH_BATCH_SIZE`.
                        let byte = unsafe { *bytes.add($pos + i) };
                        if $table.matches(byte) {
                            // We find a matched byte, jump out to check with continue_if
                            $pos += i;
                            break 'inner byte;
                        }
                        i += 1;
                    }

                    // We don't find a matched byte in this batch,
                    // So continue to try the next batch/remaining
                    $pos = batch_end;
                    continue 'outer;
                }
            } else {
                'inner: loop {
                    // The remaining is shorter than batch size.
                    let remaining_len = len - $pos;
                    let mut i = 0;
                    while i < remaining_len {
                        // Safety: `i < remaining_len`.
                        let byte = unsafe { *bytes.add($pos + i) };
                        if $table.matches(byte) {
                            // We find a matched byte, jump out to check with continue_if
                            $pos += i;
                            break 'inner byte;
                        }
                        i += 1;
                    }

                    // We don't find a matched byte in the remaining,
                    // which also means we have reached the end of the input.
                    unsafe {
                        $lexer.input_mut().bump_bytes(len);
                    }
                    $eof_handler
                }
            };

            // Check if we should continue searching
            if $should_continue {
                // Continue searching from next position
                $pos += 1;
                continue;
            }

            break $byte;
        };

        unsafe {
            $lexer.input_mut().bump_bytes($pos);
        }
        $byte
    }};
}

// ---------------------- Wide-word (SWAR) identifier scan ----------------------
//
// swc's `byte_search!` walks one byte per step through a 256-entry match table.
// Identifier-continuation runs are pervasive in real source and dominate
// token-dense files, so they are scanned here eight bytes at a time using SWAR
// (SIMD-within-a-register) arithmetic. The wide step only fast-forwards over
// chunks that are ENTIRELY ASCII identifier-continue bytes (`[A-Za-z0-9_$]`);
// the exact stop position is always resolved by the very same scalar predicate
// the table encodes, so the boundary is byte-for-byte identical to the scalar
// scan on every input.

const SWAR_ONES: u64 = 0x0101_0101_0101_0101;
const SWAR_HIGH: u64 = 0x8080_8080_8080_8080;

/// High bit set per lane where `byte > k`. Requires every lane `< 128` and
/// `k` in `0..=127`; each lane sum is at most `127 + 127`, so the addition
/// never carries across lanes.
#[inline(always)]
fn swar_gt(x: u64, k: u64) -> u64 {
    x.wrapping_add(SWAR_ONES.wrapping_mul(127 - k)) & SWAR_HIGH
}

/// High bit set per lane where `lo <= byte <= hi` (lanes `< 128`).
#[inline(always)]
fn swar_in_range(x: u64, lo: u64, hi: u64) -> u64 {
    swar_gt(x, lo - 1) & (swar_gt(x, hi) ^ SWAR_HIGH)
}

/// True iff all eight lanes of `word` are ASCII identifier-continue bytes.
#[inline(always)]
fn swar_all_id_continue(word: u64) -> bool {
    // Any lane with the high bit set is non-ASCII and cannot be id-continue.
    if word & SWAR_HIGH != 0 {
        return false;
    }
    let lower = swar_in_range(word, 0x61, 0x7a);
    let upper = swar_in_range(word, 0x41, 0x5a);
    let digit = swar_in_range(word, 0x30, 0x39);
    let underscore = swar_in_range(word, 0x5f, 0x5f);
    let dollar = swar_in_range(word, 0x24, 0x24);
    ((lower | upper | digit | underscore | dollar) & SWAR_HIGH) == SWAR_HIGH
}

/// Index of the first byte at or after `start` that is NOT an ASCII
/// identifier-continue byte, or `bytes.len()` if the remainder is all
/// identifier-continue. Byte-for-byte equivalent to scanning with
/// `NOT_ASCII_ID_CONTINUE_TABLE`, but fast-forwards whole eight-byte runs.
#[inline]
pub(crate) fn scan_ascii_id_continue(bytes: &[u8], start: usize) -> usize {
    let len = bytes.len();
    let mut pos = start;
    while pos + 8 <= len {
        let chunk: [u8; 8] = match bytes[pos..pos + 8].try_into() {
            Ok(chunk) => chunk,
            Err(_) => break,
        };
        if swar_all_id_continue(u64::from_ne_bytes(chunk)) {
            pos += 8;
        } else {
            break;
        }
    }
    while pos < len {
        let b = bytes[pos];
        if !(b.is_ascii_alphanumeric() || b == b'_' || b == b'$') {
            return pos;
        }
        pos += 1;
    }
    len
}
