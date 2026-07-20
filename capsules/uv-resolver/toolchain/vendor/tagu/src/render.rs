//!
//! Functionality to change rendering pretty print vs none.
//!

use super::*;

pub struct Renderer {
    fmt: PrettyFmt,
}
impl Renderer {
    pub fn new() -> Self {
        Renderer {
            fmt: PrettyFmt::new(),
        }
    }
}

impl Default for Renderer {
    fn default() -> Self {
        Self::new()
    }
}

impl Renderer {
    // pub fn with_fmt<K: Fmt>(self, a: K) -> Renderer<K> {
    //     Renderer { fmt: a }
    // }
    pub fn render<E: Elem + Locked, W: fmt::Write>(
        &mut self,
        elem: E,
        mut writer: W,
    ) -> fmt::Result {
        ElemWrite(WriteWrap(&mut writer), &mut self.fmt).render_inner(elem)
    }
    pub fn render_escapable<E: Elem, W: fmt::Write>(
        &mut self,
        elem: E,
        mut writer: W,
    ) -> fmt::Result {
        let mut e = ElemWrite(WriteWrap(&mut writer), &mut self.fmt);
        let tail = elem.render_head(e.borrow_mut2())?;
        tail.render(e)
    }
}

// pub trait Fmt {
//     fn push(&mut self);
//     fn pop(&mut self);
//     fn tabs(&mut self, w: &mut dyn fmt::Write) -> fmt::Result;
//     fn end_tag(&mut self, w: &mut dyn fmt::Write) -> fmt::Result;
//     fn set_inline_mode(&mut self, val: bool);
//     fn is_inline_mode(&mut self) -> bool;
// }

pub struct PrettyFmt {
    tabs: usize,
    pub tab_char: &'static str,
    inline: bool,
}

impl Default for PrettyFmt {
    fn default() -> Self {
        Self::new()
    }
}

impl PrettyFmt {
    pub fn new() -> Self {
        PrettyFmt {
            tabs: 0,
            tab_char: "\t",
            inline: false,
        }
    }
}
impl PrettyFmt {
    pub fn set_inline_mode(&mut self, val: bool) {
        self.inline = val;
    }
    pub fn is_inline_mode(&mut self) -> bool {
        self.inline
    }
    pub fn tabs(&mut self, w: &mut dyn fmt::Write) -> fmt::Result {
        if !self.inline {
            for _ in 0..self.tabs {
                write!(w, "{}", self.tab_char)?;
            }
        }

        Ok(())
    }
    pub fn push(&mut self) {
        //if !self.inline {
        self.tabs += 1;
        //}
    }
    pub fn pop(&mut self) {
        //if !self.inline {
        self.tabs -= 1;
        //}
    }
    pub fn end_tag(&mut self, w: &mut dyn fmt::Write) -> fmt::Result {
        if !self.inline {
            writeln!(w)?;
        }
        Ok(())
    }
}

// pub struct NoFmt;
// impl Fmt for NoFmt {
//     fn tabs(&mut self, _: &mut dyn fmt::Write) -> fmt::Result {
//         Ok(())
//     }
//     fn push(&mut self) {}
//     fn pop(&mut self) {}
//     fn end_tag(&mut self, _: &mut dyn fmt::Write) -> fmt::Result {
//         Ok(())
//     }
//     fn set_inline_mode(&mut self, _: bool) {}

//     fn is_inline_mode(&mut self) -> bool {
//         true
//     }
// }
