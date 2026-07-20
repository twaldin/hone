static IDENT_CHARS: [bool; 256] = {
    let mut chars = [false; 256];
    let mut i = 0;
    while i < 256 {
        let c = i as u8;
        if c.is_ascii_digit()
            || c.is_ascii_uppercase()
            || c.is_ascii_lowercase()
            || c == b'-'
            || c == b'_'
            || c == b':'
            || c == b'+'
            || c == b'/'
        {
            chars[i] = true;
        }
        i += 1;
    }
    chars
};

pub fn is_ident(c: u8) -> bool {
    IDENT_CHARS[c as usize]
}

#[inline(always)]
pub fn to_lower(byte: u8) -> u8 {
    let is_upper = byte.is_ascii_uppercase() as u8;
    let lower = is_upper * 0x20;
    byte + lower
}
