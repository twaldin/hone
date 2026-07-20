//!
//! Functions to build elements and attributes building blocks
//!

use super::*;

///
/// Create an escapable element
///
/// ```
/// let mut s = String::new();
/// let k = tagu::build::raw_escapable("<test>I can insert my own elements!</test>");
/// tagu::render_escapable(k,&mut s).unwrap()
///
/// ```
///
pub fn raw_escapable<D: fmt::Display>(data: D) -> RawEscapable<D> {
    RawEscapable::new(data)
}

pub fn raw<D: fmt::Display>(data: D) -> Raw<D> {
    Raw::new(data)
}

///
/// Create an escapable element from a closure
///
/// ```
/// let mut s = String::new();
/// let k = tagu::build::from_closure_escapable(|w|{
///
///     w.render(tagu::build::raw_escapable("<test/>"))?;
///     
///     w.render(tagu::build::single("test2"))
///
/// });
/// tagu::render_escapable(k,&mut s).unwrap()
///
/// ```
///
#[deprecated(note = "use tagu::session")]
pub fn from_closure_escapable<F: FnOnce(&mut ElemWriteEscapable) -> fmt::Result>(
    func: F,
) -> ClosureEscapable<F> {
    ClosureEscapable::new(func)
}

///
/// Create an element from a closure
///
/// ```
/// let mut s = String::new();
/// let k = tagu::build::from_closure(|w|{
///
///     w.render(tagu::build::single("test"))
///
/// });
/// tagu::render(k,&mut s).unwrap()
///
/// ```
///
#[deprecated(note = "use tagu::session")]
pub fn from_closure<F: FnOnce(&mut ElemWrite) -> fmt::Result>(func: F) -> Closure<F> {
    Closure::new(func)
}

#[deprecated(note = "use tagu::session")]
pub fn from_closure2<F: FnOnce() -> E, E: Elem>(func: F) -> Closure2<F> {
    Closure2 { func }
}

use crate::stack::*;
pub fn from_stack<F>(func: F) -> Sess<F>
where
    F: FnOnce(ElemStack<Sentinel>) -> Result<ElemStack<Sentinel>, fmt::Error>,
{
    Sess::new(func)
}

pub fn from_stack_escapable<F>(func: F) -> SessEscapable<F>
where
    F: FnOnce(ElemStackEscapable<Sentinel>) -> Result<ElemStackEscapable<Sentinel>, fmt::Error>,
{
    SessEscapable::new(func)
}

///
/// Create an element from an iterator of elements
///
/// ```
/// let mut s = String::new();
/// let k = tagu::build::from_iter((0..10).map(|_|tagu::build::single("hello")));
/// tagu::render(k,&mut s).unwrap()
///
/// ```
///
pub fn from_iter<I: Iterator<Item = R>, R: Elem>(iter: I) -> Iter<I> {
    Iter::new(iter)
}

///
/// Create an element that has no closing tag.
///
/// ```
/// let mut s = String::new();
/// let k = tagu::build::single("hello");
/// tagu::render(k,&mut s).unwrap()
///
/// ```
pub fn single<D: fmt::Display>(tag: D) -> Single<D, (), &'static str, &'static str> {
    Single::new(tag)
}

///
/// Create an element.
///
/// ```
/// let mut s = String::new();
/// let k = tagu::build::elem("hello");
/// tagu::render(k,&mut s).unwrap()
///
/// ```
pub fn elem<D: fmt::Display>(tag: D) -> Element<D, ()> {
    Element::new(tag)
}

///
/// Box an element
///
/// ```
/// let mut s = String::new();
/// let k = tagu::build::single("hello");
/// let k = tagu::build::box_elem(k);
/// tagu::render(k,&mut s).unwrap()
///
/// ```
pub fn box_elem<'a, E: Elem + 'a>(elem: E) -> DynamicElement<'a> {
    DynamicElement::new(elem)
}

///
/// Create an attr from a closure.
///
/// ```
/// use tagu::build;
/// let mut s = String::new();
/// let k = build::elem("hello").with(
///     build::attr_from_closure(|w|
///         w.render(("test","val"))
///     )
/// );
/// tagu::render(k,&mut s).unwrap()
///
/// ```
#[deprecated]
pub fn attr_from_closure<F: FnOnce(&mut AttrWrite) -> fmt::Result>(func: F) -> AttrClosure<F> {
    AttrClosure::new(func)
}

///
/// Create a path attribute
///
/// ```
/// use tagu::build;
/// use tagu::attr::PathCommand;
/// let mut s = String::new();
/// let k = build::elem("hello").with(
///     build::path(
///         (0..10).map(|_|PathCommand::L(5.0,5.0))
///     )
/// );
/// tagu::render(k,&mut s).unwrap()
///
/// ```
pub fn path<I: IntoIterator<Item = PathCommand<D>>, D: fmt::Display>(iter: I) -> Path<I> {
    Path::new(iter)
}

///
/// Create a points attribute
///
/// ```
/// use tagu::build;
/// let mut s = String::new();
/// let k = build::elem("hello").with(
///     build::points(
///         (0..10).map(|_|(5.0,5.0))
///     )
/// );
/// tagu::render(k,&mut s).unwrap()
///
/// ```
pub fn points<I: IntoIterator<Item = (D, D)>, D: fmt::Display>(iter: I) -> Points<I> {
    Points::new(iter)
}

///
/// Create a path attribute from a closure
///
/// ```
/// use tagu::build;
/// use tagu::attr::PathCommand;
/// let mut s = String::new();
/// let k = build::elem("hello").with(
///     build::path_from_closure(|w|{
///         let mut w=w.start();
///         w.put(PathCommand::L(5.0,5.0))?;
///         w.put(PathCommand::L(5.0,5.0))
///     })
/// );
/// tagu::render(k,&mut s).unwrap()
///
/// ```
///
pub fn path_from_closure<F: FnOnce(PathSinkBuilder) -> std::fmt::Result>(
    func: F,
) -> PathClosure<F> {
    PathClosure::new(func)
}
