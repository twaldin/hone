//!
//! Elem trait and building blocks
//!

use crate::render::PrettyFmt;

use super::*;

///
/// Writer struct passed to escapable closure elem
///
pub struct ElemWriteEscapable<'a>(WriteWrap<'a>, pub(crate) &'a mut PrettyFmt);

impl<'a> ElemWriteEscapable<'a> {
    pub fn borrow_mut2(&mut self) -> ElemWriteEscapable {
        ElemWriteEscapable(self.0.borrow_mut(), self.1)
    }
    pub fn writer_escapable(&mut self) -> WriteWrap {
        self.0.borrow_mut()
    }
    pub fn writer(&mut self) -> tools::EscapeGuard<WriteWrap> {
        tools::escape_guard(self.0.borrow_mut())
    }

    #[deprecated(note = "use tagu::session")]
    pub fn render<E: Elem>(&mut self, elem: E) -> fmt::Result {
        let tail = elem.render_head(self.as_elem_write())?;
        tail.render(self.as_elem_write())
    }
    fn as_elem_write(&mut self) -> ElemWrite {
        ElemWrite(WriteWrap(self.0 .0), self.1)
    }

    #[deprecated(note = "use tagu::session")]
    pub fn render_map<E: Elem, F: FnOnce() -> E>(&mut self, func: F) -> fmt::Result {
        let elem = func();
        let tail = elem.render_head(self.as_elem_write())?;
        tail.render(self.as_elem_write())
    }

    #[deprecated(note = "use tagu::session")]
    pub fn session<'b, E: Elem>(&'b mut self, elem: E) -> SessionEscapable<'b, E> {
        SessionEscapable {
            elem,
            writer: self.borrow_mut2(),
        }
    }

    #[deprecated(note = "use tagu::session")]
    pub fn session_map<'b, E: Elem, F: FnOnce() -> E>(
        &'b mut self,
        func: F,
    ) -> SessionEscapable<'b, E> {
        let elem = func();
        SessionEscapable {
            elem,
            writer: self.borrow_mut2(),
        }
    }
}

///
/// Writer struct passed to closure elem
///
#[must_use]
pub struct ElemWrite<'a>(pub(crate) WriteWrap<'a>, pub(crate) &'a mut PrettyFmt);

impl<'a> ElemWrite<'a> {
    pub(crate) fn borrow_mut2(&mut self) -> ElemWrite {
        ElemWrite(self.0.borrow_mut(), self.1)
    }

    pub fn writer(&mut self) -> tools::EscapeGuard<WriteWrap> {
        tools::escape_guard(self.0.borrow_mut())
    }

    #[deprecated(note = "use tagu::session")]
    pub fn render<E: Elem + Locked>(&mut self, elem: E) -> fmt::Result {
        self.render_inner(elem)
    }

    #[deprecated(note = "use tagu::session")]
    pub fn render_map<E: Elem + Locked, F: FnOnce() -> E>(&mut self, func: F) -> fmt::Result {
        let elem = func();
        let tail = elem.render_head(self.borrow_mut2())?;
        tail.render(self.borrow_mut2())
    }

    #[deprecated(note = "use tagu::session")]
    pub fn session<'b, E: Elem + Locked>(&'b mut self, elem: E) -> Session<'b, E> {
        Session {
            elem,
            writer: self.borrow_mut2(),
        }
    }

    fn swap_tab_type(&mut self, newt: &'static str) -> &'static str {
        let ret = self.1.tab_char;
        self.1.tab_char = newt;
        ret
    }

    #[deprecated(note = "use tagu::session")]
    pub fn session_map<'b, E: Elem + Locked, F: FnOnce() -> E>(
        &'b mut self,
        func: F,
    ) -> Session<'b, E> {
        let elem = func();
        Session {
            elem,
            writer: self.borrow_mut2(),
        }
    }

    fn set_inline_mode(&mut self, val: bool) {
        self.1.set_inline_mode(val)
    }

    fn is_inline_mode(&mut self) -> bool {
        self.1.is_inline_mode()
    }

    fn tabs(&mut self) -> fmt::Result {
        self.1.tabs(&mut self.0)
    }
    fn push(&mut self) {
        self.1.push()
    }
    fn pop(&mut self) {
        self.1.pop()
    }
    fn end_tag(&mut self) -> fmt::Result {
        self.1.end_tag(&mut self.0)
    }

    pub(crate) fn as_escapable(&mut self) -> ElemWriteEscapable {
        ElemWriteEscapable(WriteWrap(self.0 .0), self.1)
    }
    pub(crate) fn writer_escapable(&mut self) -> WriteWrap {
        self.0.borrow_mut()
    }

    fn as_attr_write(&mut self) -> AttrWrite {
        attr::AttrWrite::new(self.0.borrow_mut())
    }

    // fn new(w: &'a mut dyn fmt::Write, fmt: &'a mut dyn Fmt) -> Self {
    //     ElemWrite(WriteWrap(w), fmt)
    // }
    pub(crate) fn render_inner<E: Elem>(&mut self, elem: E) -> fmt::Result {
        let tail = elem.render_head(self.borrow_mut2())?;
        tail.render(self.borrow_mut2())
    }
}

///
/// Alternative trait for Elem that is friendly to dyn trait.
///
trait ElemDyn {
    fn render_head(&mut self, w: ElemWrite) -> Result<(), fmt::Error>;
    fn render_tail(&mut self, w: ElemWrite) -> Result<(), fmt::Error>;
}

///
/// Tail to DynElem
///
pub struct DynamicElementTail<'a> {
    elem: Box<dyn ElemDyn + 'a>,
}
impl<'a> ElemTail for DynamicElementTail<'a> {
    fn render(mut self, w: ElemWrite) -> std::fmt::Result {
        self.elem.render_tail(w)
    }
}

impl Locked for DynamicElement<'_> {}

///
/// A dynamic elem that implement Elem
///
pub struct DynamicElement<'a> {
    elem: Box<dyn ElemDyn + 'a>,
}
impl<'a> DynamicElement<'a> {
    pub fn new<E: Elem + 'a>(elem: E) -> Self {
        ///
        /// A dynamic elem, that
        ///
        pub struct DynamicElem<E: Elem> {
            head: Option<E>,
            tail: Option<E::Tail>,
        }

        impl<E: Elem> DynamicElem<E> {
            pub fn new(elem: E) -> DynamicElem<E> {
                DynamicElem {
                    head: Some(elem),
                    tail: None,
                }
            }
        }
        impl<E: Elem> ElemDyn for DynamicElem<E> {
            fn render_head(&mut self, w: ElemWrite) -> Result<(), fmt::Error> {
                let tail = self.head.take().unwrap().render_head(w)?;
                self.tail = Some(tail);
                Ok(())
            }
            fn render_tail(&mut self, w: ElemWrite) -> Result<(), fmt::Error> {
                self.tail.take().unwrap().render(w)
            }
        }

        DynamicElement {
            elem: Box::new(DynamicElem::new(elem)),
        }
    }
}

impl<'a> Elem for DynamicElement<'a> {
    type Tail = DynamicElementTail<'a>;
    fn render_head(mut self, w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        self.elem.render_head(w)?;
        Ok(DynamicElementTail { elem: self.elem })
    }
}

///
/// Main building block.
///
pub trait Elem {
    type Tail: ElemTail;
    fn render_head(self, w: ElemWrite) -> Result<Self::Tail, fmt::Error>;

    #[deprecated]
    fn render_closure<K>(
        self,
        mut w: ElemWrite,
        func: impl FnOnce(ElemWrite) -> Result<K, fmt::Error>,
    ) -> Result<K, fmt::Error>
    where
        Self: Sized,
    {
        let tail = self.render_head(w.borrow_mut2())?;
        let res = func(w.borrow_mut2())?;
        tail.render(w)?;
        Ok(res)
    }

    /// Render all of Self and head of other, store tail of other.
    fn chain<R: Elem>(self, other: R) -> Chain<Self, R>
    where
        Self: Sized,
    {
        Chain {
            top: self,
            bottom: other,
        }
    }

    /// Render head of Self, and all of other, store tail of self.
    fn append<R: Elem>(self, bottom: R) -> Append<Self, R>
    where
        Self: Sized,
    {
        Append { top: self, bottom }
    }

    fn append_with<F: FnOnce() -> R, R: Elem>(self, func: F) -> AppendWith<Self, F>
    where
        Self: Sized,
    {
        AppendWith {
            top: self,
            bottom: func,
        }
    }

    ///
    /// Force this element and descendants to be written out
    /// inline.
    ///
    fn inline(self) -> Inliner<Self>
    where
        Self: Sized,
    {
        Inliner { elem: self }
    }

    fn with_tab(self, new_tab: &'static str) -> WithTab<Self>
    where
        Self: Sized,
    {
        WithTab {
            elem: self,
            new_tab,
        }
    }

    fn some(self) -> Option<Self>
    where
        Self: Sized,
    {
        Some(self)
    }
}

///
/// Indicates that the implementor does that allow arbitrary html escaping.
///
pub trait Locked {}

#[must_use]
#[derive(Copy, Clone)]
pub struct AppendWith<A, B> {
    top: A,
    bottom: B,
}

impl<A: Locked, B: FnOnce() -> C, C: Locked> Locked for AppendWith<A, B> {}

impl<A: Elem, B: FnOnce() -> K, K: Elem> Elem for AppendWith<A, B> {
    type Tail = A::Tail;
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let AppendWith { top, bottom } = self;
        let tail = top.render_head(w.borrow_mut2())?;
        w.render_inner(bottom())?;
        Ok(tail)
    }
}

///
/// Append an element to another adaptor
///
#[must_use]
#[derive(Copy, Clone)]
pub struct Append<A, B> {
    top: A,
    bottom: B,
}

impl<A: Locked, B: Locked> Locked for Append<A, B> {}

impl<A: Elem, B: Elem> Elem for Append<A, B> {
    type Tail = A::Tail;
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let Append { top, bottom } = self;
        let tail = top.render_head(w.borrow_mut2())?;
        w.render_inner(bottom)?;
        Ok(tail)
    }
}

impl<A: Locked> Locked for Option<A> {}

impl<A: ElemTail> ElemTail for Option<A> {
    fn render(self, w: ElemWrite) -> std::fmt::Result {
        if let Some(a) = self {
            a.render(w)?;
        }
        Ok(())
    }
}
impl<A: Elem> Elem for Option<A> {
    type Tail = Option<A::Tail>;
    fn render_head(self, w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        if let Some(a) = self {
            Ok(Some(a.render_head(w)?))
        } else {
            Ok(None)
        }
    }
}

///
/// Chain two elements adaptor
///
#[must_use]
#[derive(Copy, Clone)]
pub struct Chain<A, B> {
    top: A,
    bottom: B,
}
impl<A: Locked, B: Locked> Locked for Chain<A, B> {}

impl<A: Elem, B: Elem> Elem for Chain<A, B> {
    type Tail = B::Tail;
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let Chain { top, bottom } = self;
        w.render_inner(top)?;
        bottom.render_head(w)
    }
}

///
/// Tail to elem trait.
///
pub trait ElemTail {
    fn render(self, w: ElemWrite) -> std::fmt::Result;
}

///
/// Used to start a closure session
///
#[must_use]
pub struct Session<'b, E> {
    elem: E,
    writer: ElemWrite<'b>,
}

impl<'b, E: Elem> Session<'b, E> {
    pub fn build(self, func: impl FnOnce(&mut ElemWrite) -> fmt::Result) -> fmt::Result {
        let Session { elem, mut writer } = self;
        let tail = elem.render_head(writer.borrow_mut2())?;
        func(&mut writer)?;
        tail.render(writer)
    }
}

///
/// Used to start an escapable closure session
///
#[must_use]
pub struct SessionEscapable<'b, E> {
    elem: E,
    writer: ElemWriteEscapable<'b>,
}

impl<'b, E: Elem> SessionEscapable<'b, E> {
    pub fn build(self, func: impl FnOnce(&mut ElemWriteEscapable) -> fmt::Result) -> fmt::Result {
        let SessionEscapable { elem, mut writer } = self;
        let tail = elem.render_head(writer.as_elem_write())?;
        func(&mut writer)?;
        tail.render(writer.as_elem_write())
    }
}

impl<I: FnOnce(&mut ElemWriteEscapable) -> fmt::Result> Elem for ClosureEscapable<I> {
    type Tail = ();
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        (self.func)(&mut w.as_escapable())?;
        Ok(())
    }
}

///
/// An escapable closure elem
///
#[derive(Copy, Clone)]
#[must_use]
pub struct ClosureEscapable<I> {
    func: I,
}

impl<I: FnOnce(&mut ElemWriteEscapable) -> fmt::Result> ClosureEscapable<I> {
    pub fn new(func: I) -> ClosureEscapable<I> {
        ClosureEscapable { func }
    }
}

pub struct Closure2<I> {
    pub func: I,
}

impl<I: FnOnce() -> E, E: Elem> Locked for Closure2<I> {}

impl<I: FnOnce() -> E, E: Elem> Elem for Closure2<I> {
    type Tail = E::Tail;
    fn render_head(self, w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let e = (self.func)();
        e.render_head(w)
    }
}

///
/// A closure elem
///
#[derive(Copy, Clone)]
#[must_use]
pub struct Closure<I> {
    func: I,
}

impl<I: FnOnce(&mut ElemWrite) -> fmt::Result> Closure<I> {
    pub fn new(func: I) -> Closure<I> {
        Closure { func }
    }
}

impl<I: FnOnce(&mut ElemWrite) -> fmt::Result> Locked for Closure<I> {}

impl<I: FnOnce(&mut ElemWrite) -> fmt::Result> Elem for Closure<I> {
    type Tail = ();
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        (self.func)(&mut w)?;
        Ok(())
    }
}

///
/// An iterator of elems
///
#[derive(Copy, Clone)]
#[must_use]
pub struct Iter<I> {
    iter: I,
}
impl<I: IntoIterator<Item = R>, R: Elem> Iter<I> {
    pub fn new(iter: I) -> Iter<I> {
        Iter { iter }
    }
}
impl<I: IntoIterator<Item = R>, R: Locked> Locked for Iter<I> {}

impl<I: IntoIterator<Item = R>, R: Elem> Elem for Iter<I> {
    type Tail = ();
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        for i in self.iter {
            w.render_inner(i)?;
        }
        Ok(())
    }
}

#[must_use]
#[derive(Copy, Clone)]
pub struct Raw<D> {
    data: D,
}
impl<D: fmt::Display> Raw<D> {
    pub fn new(data: D) -> Raw<D> {
        Raw { data }
    }
}

impl<D: fmt::Display> Locked for Raw<D> {}
impl<D: fmt::Display> Elem for Raw<D> {
    type Tail = ();
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        //w.tabs()?;
        write!(w.writer(), "{}", self.data)?;
        w.end_tag()?;
        Ok(())
    }
}

// impl<'a> Locked for &'a str {}
// impl<'a> Elem for &'a str {
//     type Tail = ();
//     fn render_head(self, w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
//         Raw::new(self).render_head(w)
//     }
// }

///
/// A raw escapable element
///
#[derive(Copy, Clone)]
#[must_use]
pub struct RawEscapable<D> {
    data: D,
}
impl<D: fmt::Display> RawEscapable<D> {
    pub fn new(data: D) -> RawEscapable<D> {
        RawEscapable { data }
    }
}
impl<D: fmt::Display> Elem for RawEscapable<D> {
    type Tail = ();
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        //w.tabs()?;
        write!(w.writer_escapable(), "{}", self.data)?;
        w.end_tag()?;
        Ok(())
    }
}

use fmt::Write;

///
/// A element with no ending tag
///
#[derive(Copy, Clone)]
#[must_use]
pub struct Single<D, A, K, Z> {
    tag: D,
    attr: A,
    start: K,
    ending: Z,
}
impl<D: fmt::Display, A: Attr, K: fmt::Display, Z: fmt::Display> Locked for Single<D, A, K, Z> {}
impl<D: fmt::Display, A: Attr, K, Z> Single<D, A, K, Z> {
    pub fn with<AA: Attr>(self, attr: AA) -> Single<D, AttrChain<A, AA>, K, Z> {
        Single {
            tag: self.tag,
            attr: self.attr.chain(attr),
            ending: self.ending,
            start: self.start,
        }
    }

    pub fn with_ending<ZZ: fmt::Display>(self, ending: ZZ) -> Single<D, A, K, ZZ> {
        Single {
            tag: self.tag,
            attr: self.attr,
            ending,
            start: self.start,
        }
    }
    pub fn with_start<KK: fmt::Display>(self, start: KK) -> Single<D, A, KK, Z> {
        Single {
            tag: self.tag,
            attr: self.attr,
            ending: self.ending,
            start,
        }
    }
}
impl<D: fmt::Display, A: Attr, K: fmt::Display, Z: fmt::Display> Elem for Single<D, A, K, Z> {
    type Tail = ();
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let Single {
            tag,
            attr,
            start,
            ending,
        } = self;
        w.tabs()?;
        w.writer_escapable().write_char('<')?;
        write!(w.writer(), "{}{}", start, tag)?;
        //w.writer().write_char(' ')?;
        attr.render(&mut w.as_attr_write())?;
        write!(w.writer(), "{}", ending)?;
        w.writer_escapable().write_str(">")?;
        w.end_tag()?;
        Ok(())
    }
}

impl<D: fmt::Display> Single<D, (), &'static str, &'static str> {
    pub fn new(tag: D) -> Self {
        Single {
            tag,
            attr: (),
            start: "",
            ending: "/",
        }
    }
}

///
/// The tail of an element
///
#[derive(Copy, Clone)]
#[must_use]
pub struct ElementTail<D> {
    tag: D,
}

impl<D: fmt::Display> ElemTail for ElementTail<D> {
    fn render(self, mut w: ElemWrite) -> std::fmt::Result {
        w.pop();

        //w.end_tag()?;
        w.tabs()?;

        w.writer_escapable().write_str("</")?;
        write!(w.writer(), "{}", &self.tag)?;
        w.writer_escapable().write_char('>')?;
        w.end_tag()?;

        Ok(())
    }
}

pub struct InlinerTail<K: ElemTail> {
    reset: bool,
    tail: K,
}

impl<D: ElemTail> ElemTail for InlinerTail<D> {
    fn render(self, mut w: ElemWrite) -> std::fmt::Result {
        self.tail.render(w.borrow_mut2())?;

        if self.reset {
            w.set_inline_mode(false);
            w.end_tag()?;
        }

        Ok(())
    }
}

#[derive(Copy, Clone)]
#[must_use]
pub struct Inliner<E> {
    elem: E,
}
impl<E> Locked for Inliner<E> {}
impl<E: Elem> Elem for Inliner<E> {
    type Tail = InlinerTail<E::Tail>;
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let reset = if w.is_inline_mode() {
            false
        } else {
            w.tabs()?;
            w.set_inline_mode(true);
            true
        };
        let tail = self.elem.render_head(w)?;

        Ok(InlinerTail { reset, tail })
    }
}

pub struct WithTabTail<T> {
    tail: T,
    original: &'static str,
}
impl<T: ElemTail> ElemTail for WithTabTail<T> {
    fn render(self, mut w: ElemWrite) -> std::fmt::Result {
        self.tail.render(w.borrow_mut2())?;

        let _ = w.swap_tab_type(self.original);

        Ok(())
    }
}
pub struct WithTab<E> {
    new_tab: &'static str,
    elem: E,
}
impl<E> Locked for WithTab<E> {}
impl<E: Elem> Elem for WithTab<E> {
    type Tail = WithTabTail<E::Tail>;
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let original = w.swap_tab_type(self.new_tab);
        let tail = self.elem.render_head(w.borrow_mut2())?;

        Ok(WithTabTail { original, tail })
    }
}

///
/// A regular element with an ending tag
///
#[derive(Copy, Clone)]
#[must_use]
pub struct Element<D, A> {
    tag: D,
    attr: A,
}

impl<D: fmt::Display, A: Attr> Locked for Element<D, A> {}

impl<D: fmt::Display, A: Attr> Element<D, A> {
    pub fn with<AA: Attr>(self, attr: AA) -> Element<D, AttrChain<A, AA>> {
        Element {
            tag: self.tag,
            attr: self.attr.chain(attr),
        }
    }
}
impl<D: fmt::Display, A: Attr> Elem for Element<D, A> {
    type Tail = ElementTail<D>;
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let Element { tag, attr } = self;
        w.tabs()?;
        w.writer_escapable().write_char('<')?;
        write!(w.writer(), "{}", tag)?;
        //w.writer().write_char(' ')?;
        attr.render(&mut w.as_attr_write())?;
        w.writer_escapable().write_str(">")?;

        w.end_tag()?;

        w.push();
        Ok(ElementTail { tag })
    }
}
impl<D: fmt::Display> Element<D, ()> {
    pub fn new(tag: D) -> Self {
        Element { tag, attr: () }
    }
}

///
/// A string buffered element
///
/// If you need to render something over, and over again,
/// you can instead buffer it to a string using this struct
/// for better performance at the cost of more memory.
///
/// Notice that RenderElem is only implemented for a &BufferedElem.
///
#[derive(Clone)]
pub struct BufferedElem {
    head: String,
    tail: String,
}

impl BufferedElem {
    pub fn new<E: Elem + Locked>(elem: E) -> Result<Self, fmt::Error> {
        let mut fmt = crate::render::PrettyFmt::new();
        let mut head = String::new();
        let mut tail = String::new();
        let t = elem.render_head(ElemWrite(WriteWrap(&mut head), &mut fmt))?;
        t.render(ElemWrite(WriteWrap(&mut tail), &mut fmt))?;
        head.shrink_to_fit();
        tail.shrink_to_fit();
        Ok(BufferedElem { head, tail })
    }

    pub fn into_parts(self) -> (String, String) {
        (self.head, self.tail)
    }
}

///
/// A buffered element's tail
///
pub struct BufferedTail<'a> {
    tail: &'a str,
}
impl<'a> ElemTail for BufferedTail<'a> {
    fn render(self, mut w: ElemWrite) -> std::fmt::Result {
        write!(w.writer_escapable(), "{}", self.tail)
    }
}
impl<'a> Locked for &'a BufferedElem {}

impl<'a> Elem for &'a BufferedElem {
    type Tail = BufferedTail<'a>;
    fn render_head(self, mut w: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        write!(w.writer_escapable(), "{}", self.head)?;
        Ok(BufferedTail { tail: &self.tail })
    }
}

impl ElemTail for () {
    fn render(self, _: ElemWrite) -> std::fmt::Result {
        Ok(())
    }
}
