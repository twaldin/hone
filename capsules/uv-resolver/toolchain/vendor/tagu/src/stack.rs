use super::*;
pub struct Sentinel {
    _p: (),
}

pub trait Pop {
    type Curr: ElemTail;
    type Last;
    fn next(self) -> (Self::Curr, Self::Last);
}
impl<E: ElemTail, O> Pop for Popper<E, O> {
    type Curr = E;
    type Last = O;
    fn next(self) -> (E, O) {
        (self.elem, self.last)
    }
}

pub struct Popper<E, O> {
    elem: E,
    last: O,
}

pub struct ElemStack<'a, T>(ElemStackEscapable<'a, T>);

impl<'a, T> ElemStack<'a, T> {
    pub fn put<E: Elem + Locked>(&mut self, elem: E) -> fmt::Result {
        self.0.put(elem)
    }
    pub fn push<E: Elem + Locked>(
        self,
        elem: E,
    ) -> Result<ElemStack<'a, Popper<E::Tail, T>>, fmt::Error> {
        self.0.push(elem).map(|a| ElemStack(a))
    }

    pub fn writer(&mut self) -> tools::EscapeGuard<WriteWrap> {
        self.0.writer.writer()
    }
}

impl<'a, P: Pop> ElemStack<'a, P> {
    pub fn pop(self) -> Result<ElemStack<'a, P::Last>, fmt::Error> {
        self.0.pop().map(|a| ElemStack(a))
    }
}

pub struct ElemStackEscapable<'a, T> {
    writer: ElemWrite<'a>,
    inner: T,
}

impl<'a, T> ElemStackEscapable<'a, T> {
    pub fn put<E: Elem>(&mut self, elem: E) -> fmt::Result {
        self.writer.render_inner(elem)
    }
    pub fn push<E: Elem>(
        mut self,
        elem: E,
    ) -> Result<ElemStackEscapable<'a, Popper<E::Tail, T>>, fmt::Error> {
        let tail = elem.render_head(self.writer.borrow_mut2())?;
        Ok(self.push_tail(tail))
    }
    fn push_tail<O>(self, tail: O) -> ElemStackEscapable<'a, Popper<O, T>> {
        ElemStackEscapable {
            writer: self.writer,
            inner: Popper {
                elem: tail,
                last: self.inner,
            },
        }
    }

    pub fn writer_escapable(&mut self) -> WriteWrap {
        self.writer.writer_escapable()
    }
}

impl<'a, P: Pop> ElemStackEscapable<'a, P> {
    pub fn pop(mut self) -> Result<ElemStackEscapable<'a, P::Last>, fmt::Error> {
        let (e, l) = self.inner.next();
        e.render(self.writer.borrow_mut2())?;

        Ok(ElemStackEscapable {
            writer: self.writer,
            inner: l,
        })
    }
}

pub struct Sess<F> {
    func: F,
}
impl<F> Sess<F>
where
    F: FnOnce(ElemStack<Sentinel>) -> Result<ElemStack<Sentinel>, fmt::Error>,
{
    pub fn new(func: F) -> Self {
        Self { func }
    }
}

impl<F> Locked for Sess<F> {}

impl<F> Elem for Sess<F>
where
    F: FnOnce(ElemStack<Sentinel>) -> Result<ElemStack<Sentinel>, fmt::Error>,
{
    type Tail = ();
    fn render_head(self, writer: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let k = ElemStack(ElemStackEscapable {
            writer,
            inner: Sentinel { _p: () },
        });
        let _ = (self.func)(k)?;
        Ok(())
    }
}

pub struct SessEscapable<F> {
    func: F,
}
impl<F> SessEscapable<F>
where
    F: FnOnce(ElemStackEscapable<Sentinel>) -> Result<ElemStackEscapable<Sentinel>, fmt::Error>,
{
    pub fn new(func: F) -> Self {
        Self { func }
    }
}

impl<F> Elem for SessEscapable<F>
where
    F: FnOnce(ElemStackEscapable<Sentinel>) -> Result<ElemStackEscapable<Sentinel>, fmt::Error>,
{
    type Tail = ();
    fn render_head(self, writer: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let k = ElemStackEscapable {
            writer,
            inner: Sentinel { _p: () },
        };
        let _ = (self.func)(k)?;
        Ok(())
    }
}

///
/// If you dont want to use a closure, you can implement this trait
///
pub trait ElemOuter {
    fn render<'a>(self, w: ElemStack<'a, Sentinel>) -> Result<ElemStack<'a, Sentinel>, fmt::Error>;
}
impl<E: ElemOuter> Locked for E {}
impl<E: ElemOuter> Elem for E {
    type Tail = ();

    fn render_head(self, writer: ElemWrite) -> Result<Self::Tail, fmt::Error> {
        let k = ElemStack(ElemStackEscapable {
            writer,
            inner: Sentinel { _p: () },
        });

        let _ = self.render(k)?;
        Ok(())
    }
}
