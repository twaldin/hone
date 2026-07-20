use std::arch::aarch64::*;

/// NEON-optimized search for the first non-identifier byte.
///
/// An identifier byte is one of:
/// - '0'-'9' (digits)
/// - 'a'-'z' (lowercase letters)
/// - 'A'-'Z' (uppercase letters)
/// - '-' (hyphen)
/// - '_' (underscore)
/// - '/' (slash)
/// - ':' (colon)
/// - '+' (plus)
pub unsafe fn search_non_ident_neon(haystack: &[u8]) -> Option<usize> {
    // If the haystack is too small, short-circuit to the fallback implementation.
    let len = haystack.len();
    if len < 16 {
        return super::fallback::search_non_ident(haystack);
    }

    let ptr = haystack.as_ptr();
    let mut offset = 0;

    // Process the input in 16-byte chunks.
    while offset + 16 <= len {
        let chunk = vld1q_u8(ptr.add(offset));

        let is_ident = is_ident_chunk(chunk);

        // Determine whether there are _any_ non-identifier bytes in this chunk.
        // This is faster than computing the full `movemask` when all bytes are identifiers.
        if has_zero_byte(is_ident) {
            // Find the first `0x00` byte using the movemask workaround.
            let mask = movemask_zero_bytes(is_ident);
            let pos = (mask.trailing_zeros() as usize) >> 2;
            return Some(offset + pos);
        }

        offset += 16;
    }

    // Handle any remaining bytes with the fallback implementation.
    if offset < len {
        super::fallback::search_non_ident(&haystack[offset..]).map(|x| offset + x)
    } else {
        None
    }
}

/// Returns a mask where each byte is `0xFF` if it's an identifier character or `0x00` otherwise.
#[inline(always)]
unsafe fn is_ident_chunk(chunk: uint8x16_t) -> uint8x16_t {
    // Check for letters using the case-folding trick: OR with 0x20 to make lowercase, subtract 'a', check if < 26
    let lower = vorrq_u8(chunk, vdupq_n_u8(0x20));
    let letter_offset = vsubq_u8(lower, vdupq_n_u8(b'a'));
    let is_letter = vcltq_u8(letter_offset, vdupq_n_u8(26));

    // Check for digits: subtract '0', check if < 10
    let digit_offset = vsubq_u8(chunk, vdupq_n_u8(b'0'));
    let is_digit = vcltq_u8(digit_offset, vdupq_n_u8(10));

    // Check for special characters: '-' (0x2D), '_' (0x5F), '/' (0x2F), ':' (0x3A), '+' (0x2B)
    let is_hyphen = vceqq_u8(chunk, vdupq_n_u8(b'-'));
    let is_underscore = vceqq_u8(chunk, vdupq_n_u8(b'_'));
    let is_slash = vceqq_u8(chunk, vdupq_n_u8(b'/'));
    let is_colon = vceqq_u8(chunk, vdupq_n_u8(b':'));
    let is_plus = vceqq_u8(chunk, vdupq_n_u8(b'+'));

    // Combine all masks.
    let is_alnum = vorrq_u8(is_letter, is_digit);
    let is_special1 = vorrq_u8(is_hyphen, is_underscore);
    let is_special2 = vorrq_u8(is_slash, is_colon);
    let is_special3 = vorrq_u8(is_special2, is_plus);
    let is_special = vorrq_u8(is_special1, is_special3);
    vorrq_u8(is_alnum, is_special)
}

/// Determine whether a vector contains any zero bytes.
#[inline(always)]
unsafe fn has_zero_byte(v: uint8x16_t) -> bool {
    // If the minimum across all lanes is not 0xFF, there's at least one zero byte.
    vminvq_u8(v) != 0xFF
}

/// Create a movemask for zero bytes in a NEON vector.
///
/// This uses the movemask workaround for NEON, which lacks a native `movemask` instruction.
/// The algorithm:
/// 1. Compare the vector to zero to get a mask of 0xFF where bytes are zero
/// 2. Reinterpret as u16x8 and use `vshrn_n_u16` to extract high bits
/// 3. This produces a u64 where every 4 bits represents one original byte lane
///
/// Returns a u64 where each 4-bit nibble corresponds to an input byte lane.
/// Non-zero nibbles indicate zero bytes in the input. Use `trailing_zeros() >> 2`
/// to find the index of the first zero byte.
///
/// Reference: https://github.com/BurntSushi/memchr/blob/master/src/vector.rs
#[inline(always)]
unsafe fn movemask_zero_bytes(v: uint8x16_t) -> u64 {
    // Create a mask where zero bytes become 0xFF and non-zero become 0x00.
    let zero_mask = vceqzq_u8(v);

    // Reinterpret as u16x8 and shift right to extract high bits.
    let as_u16 = vreinterpretq_u16_u8(zero_mask);
    let narrowed = vshrn_n_u16(as_u16, 4);

    // Extract and return the 64-bit result.
    let as_u64 = vreinterpret_u64_u8(narrowed);
    vget_lane_u64(as_u64, 0)
}
