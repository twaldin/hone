use std::iter::Peekable;
use std::slice::Iter;

/// Helper method that returns None if test is true
#[inline]
#[must_use]
pub fn fail_if(test: bool) -> Option<()> {
    if test {
        None
    } else {
        Some(())
    }
}

#[inline]
pub fn is_whitespace(c: u8) -> bool {
    c == b'\t' || c == b' '
}

#[inline]
fn into_digit(c: u8) -> u64 {
    u64::from(c - b'0')
}

pub(crate) trait IterExt {
    #[must_use]
    fn skip_spaces(&mut self) -> Option<u8>;
    #[must_use]
    fn parse_separator(&mut self, separator: u8) -> Option<u8>;
    #[must_use]
    fn parse_u64(&mut self) -> Option<u64>;
}

impl IterExt for Peekable<Iter<'_, u8>> {
    /// Advances to the next non-blank byte, returning true if there is more data
    fn skip_spaces(&mut self) -> Option<u8> {
        loop {
            match self.peek() {
                None => return None,
                Some(v) => {
                    if is_whitespace(**v) {
                        self.next();
                    } else {
                        return Some(**v);
                    }
                }
            }
        }
    }

    /// Skip spaces, and ensure there is a given separator. Returns next non-space value
    fn parse_separator(&mut self, separator: u8) -> Option<u8> {
        if self.skip_spaces()? != separator {
            return None;
        }
        self.next()?; // consume separator
        self.skip_spaces()
    }

    /// Consume u64 value
    fn parse_u64(&mut self) -> Option<u64> {
        let mut res = match self.next() {
            None => return None,
            Some(v) => {
                let c = *v;
                if !c.is_ascii_digit() {
                    return None;
                }
                into_digit(*v)
            }
        };
        loop {
            match self.peek() {
                None => return Some(res),
                Some(v) => {
                    let next = **v;
                    if next.is_ascii_digit() {
                        res = res.checked_mul(10)?.checked_add(into_digit(next))?;
                        self.next();
                    } else {
                        return Some(res);
                    }
                }
            }
        }
    }
}
