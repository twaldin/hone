use core::arch::x86_64::*;

/// SSE2-optimized search for the first non-identifier byte.
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
#[target_feature(enable = "sse2")]
pub unsafe fn search_non_ident_sse2(haystack: &[u8]) -> Option<usize> {
    // If the haystack is too small, short-circuit to the fallback implementation.
    let len = haystack.len();
    if len < 16 {
        return super::fallback::search_non_ident(haystack);
    }

    let ptr = haystack.as_ptr();
    let mut offset = 0;

    // Process the input in 16-byte chunks.
    while offset + 16 <= len {
        let chunk = _mm_loadu_si128(ptr.add(offset) as *const __m128i);

        let is_ident = is_ident_chunk(chunk);

        // Invert to get the non-identifier mask.
        let mask = _mm_movemask_epi8(is_ident);

        // If the mask is _not_ all 1s, there is at least one non-identifier byte.
        if mask != 0xFFFF {
            let inverted = !mask & 0xFFFF;
            let pos = inverted.trailing_zeros() as usize;
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
unsafe fn is_ident_chunk(chunk: __m128i) -> __m128i {
    // '0'-'9' (0x30-0x39)
    let ge_0 = _mm_cmpgt_epi8(chunk, _mm_set1_epi8(0x2F)); // >= '0'
    let le_9 = _mm_cmplt_epi8(chunk, _mm_set1_epi8(0x3A)); // <= '9'
    let is_digit = _mm_and_si128(ge_0, le_9);

    // 'a'-'z' (0x61-0x7A)
    let ge_a_lower = _mm_cmpgt_epi8(chunk, _mm_set1_epi8(0x60)); // >= 'a'
    let le_z_lower = _mm_cmplt_epi8(chunk, _mm_set1_epi8(0x7B)); // <= 'z'
    let is_lowercase = _mm_and_si128(ge_a_lower, le_z_lower);

    // 'A'-'Z' (0x41-0x5A)
    let ge_a_upper = _mm_cmpgt_epi8(chunk, _mm_set1_epi8(0x40)); // >= 'A'
    let le_z_upper = _mm_cmplt_epi8(chunk, _mm_set1_epi8(0x5B)); // <= 'Z'
    let is_uppercase = _mm_and_si128(ge_a_upper, le_z_upper);

    // '-' (0x2D)
    let is_hyphen = _mm_cmpeq_epi8(chunk, _mm_set1_epi8(0x2D));

    // '_' (0x5F)
    let is_underscore = _mm_cmpeq_epi8(chunk, _mm_set1_epi8(0x5F));

    // '/' (0x2F)
    let is_slash = _mm_cmpeq_epi8(chunk, _mm_set1_epi8(0x2F));

    // ':' (0x3A)
    let is_colon = _mm_cmpeq_epi8(chunk, _mm_set1_epi8(0x3A));

    // '+' (0x2B)
    let is_plus = _mm_cmpeq_epi8(chunk, _mm_set1_epi8(0x2B));

    // Combine all identifier character masks.
    let is_alpha = _mm_or_si128(is_lowercase, is_uppercase);
    let is_alnum = _mm_or_si128(is_digit, is_alpha);
    let is_special1 = _mm_or_si128(is_hyphen, is_underscore);
    let is_special2 = _mm_or_si128(is_slash, is_colon);
    let is_special3 = _mm_or_si128(is_special2, is_plus);
    let is_special = _mm_or_si128(is_special1, is_special3);
    _mm_or_si128(is_alnum, is_special)
}
