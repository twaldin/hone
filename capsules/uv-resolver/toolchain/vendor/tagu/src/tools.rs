//!
//! Misc functions
//!

use std::fmt;

///
/// Writer adaptor that disallows escaping from xml.
///
pub fn escape_guard<T: std::fmt::Write>(a: T) -> EscapeGuard<T> {
    EscapeGuard::new(a)
}

/// Writer adaptor that replaces xml escaping characters with their encoded value.
///
/// Disallowed characters are `"` `'` `<` `>` `&`. characters are replaced with their equivalent from:
/// [https://dev.w3.org/html5/html-author/charref](https://dev.w3.org/html5/html-author/charref)
///
pub struct EscapeGuard<T> {
    writer: T,
}

impl<T: std::fmt::Write> EscapeGuard<T> {
    pub fn new(writer: T) -> EscapeGuard<T> {
        EscapeGuard { writer }
    }
}

impl<T: std::fmt::Write> std::fmt::Write for EscapeGuard<T> {
    fn write_str(&mut self, s: &str) -> Result<(), std::fmt::Error> {
        for c in s.chars() {
            let r = match c {
                '\"' => Some("&quot;"),
                '\'' => Some("&apos;"),
                '<' => Some("&lt;"),
                '>' => Some("&gt;"),
                '&' => Some("&amp;"),
                _ => None,
            };

            if let Some(r) = r {
                self.writer.write_str(r)?;
            } else {
                self.writer.write_char(c)?;
            }
        }
        Ok(())
    }
}

///
/// Used to wrap a `std::io::Write` to have `std::fmt::Write`.
/// The underlying error can be extracted through the error field.
///
pub struct Adaptor<T> {
    pub inner: T,
    pub error: Result<(), std::io::Error>,
}

///
/// Update a `std::io::Write` to be a `std::fmt::Write`
///
pub fn upgrade_write<T: std::io::Write>(inner: T) -> Adaptor<T> {
    Adaptor {
        inner,
        error: Ok(()),
    }
}

impl<T: std::io::Write> std::fmt::Write for Adaptor<T> {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        match self.inner.write_all(s.as_bytes()) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.error = Err(e);
                Err(std::fmt::Error)
            }
        }
    }
}

///
/// Similar to `std::format_args!()` except has a more flexible lifetime.
/// Shorthand for `disp_const(move |w|write!(w,...))`
///
#[macro_export]
macro_rules! format_move {
    ($($arg:tt)*) => {
        $crate::tools::disp_const(move |w| write!(w,$($arg)*))
    }
}

///
/// Convert a closure to a object that implements Display
///
pub fn disp_const<F: Fn(&mut fmt::Formatter) -> fmt::Result>(a: F) -> DisplayableClosure<F> {
    DisplayableClosure::new(a)
}

/// Convert a moved closure into a impl fmt::Display.
/// This is useful because std's `format_args!()` macro
/// has a shorter lifetime.
pub struct DisplayableClosure<F>(pub F);

impl<F: Fn(&mut fmt::Formatter) -> fmt::Result> DisplayableClosure<F> {
    #[inline(always)]
    pub fn new(a: F) -> Self {
        DisplayableClosure(a)
    }
}
impl<F: Fn(&mut fmt::Formatter) -> fmt::Result> fmt::Display for DisplayableClosure<F> {
    #[inline(always)]
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        (self.0)(formatter)
    }
}

///
/// Wrapper around a &mut dyn std::fmt::Write
///
pub struct WriteWrap<'a>(pub &'a mut dyn fmt::Write);

impl<'a> WriteWrap<'a> {
    pub fn borrow_mut(&mut self) -> WriteWrap {
        WriteWrap(self.0)
    }
}
impl fmt::Write for WriteWrap<'_> {
    fn write_str(&mut self, s: &str) -> Result<(), fmt::Error> {
        self.0.write_str(s)
    }

    fn write_char(&mut self, c: char) -> Result<(), fmt::Error> {
        self.0.write_char(c)
    }
    fn write_fmt(&mut self, args: fmt::Arguments<'_>) -> Result<(), fmt::Error> {
        self.0.write_fmt(args)
    }
}
