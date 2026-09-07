Build xml / html / svg programmatically by chaining structs together or by closures. Instead of using a templating engine, write data/markup that 'looks like' rust. User has control over formatting via the `inline()` function.

You can find tagu on [github](https://github.com/tiby312/tagu) and [crates.io](https://crates.io/crates/tagu).
Documentation at [docs.rs](https://docs.rs/tagu)


### Adaptor Example:

```rust
use tagu::build;
use tagu::prelude::*;

fn main() -> std::fmt::Result {
    let a = build::elem("a");
    let b = build::elem("b");
    let c = build::elem("c");
    let it = build::from_iter((0..5).map(|i| build::elem(format_move!("x{}", i)).inline()));
    let all = a.append(b.append(c.append(it)));

    tagu::render(all, tagu::stdout_fmt())
}

```

### Output Text:
```html
<a>
    <b>
        <c>
            <x0></x0>
            <x1></x1>
            <x2></x2>
            <x3></x3>
            <x4></x4>
        </c>
    </b>
</a>
```

## Stack Example

```rust
use tagu::build;
use tagu::prelude::*;

fn main() -> std::fmt::Result {
    let all = build::from_stack(|stack| {
        let a = build::elem("a");
        let b = build::elem("b");
        let c = build::elem("c").with_tab("→");

        let mut stack = stack.push(a)?.push(b)?.push(c)?;

        for i in 0..5 {
            let e = build::elem(format_move!("x{}", i)).inline();
            stack.put(e)?;
        }
        stack.pop()?.pop()?.pop()
    });

    tagu::render(all.with_tab(" "), tagu::stdout_fmt())
}

```

### Output Text:
```html
<a>
 <b>
→→<c>
→→→<x0></x0>
→→→<x1></x1>
→→→<x2></x2>
→→→<x3></x3>
→→→<x4></x4>
→→</c>
 </b>
</a>
```

### Adaptor2 Example

```rust
use tagu::build;
use tagu::prelude::*;

fn main() -> std::fmt::Result {
    let all = build::elem("a").append_with(|| {
        elems!(
            build::single("test"),
            build::elem("b").append_with(|| {
                let it =
                    build::from_iter((0..5).map(|i| build::elem(format_move!("x{}", i)).inline()));

                build::elem("c").append_with(|| it)
            }),
            build::elem("bbbb").append_with(|| {
                elems!(
                    tagu::util::comment("this is comment"),
                    build::single("k").with(("apple", 5))
                )
            })
        )
    });

    tagu::render(all, tagu::stdout_fmt())
}
```

### Output

```html
<a>
    <test/>
    <b>
        <c>
            <x0></x0>
            <x1></x1>
            <x2></x2>
            <x3></x3>
            <x4></x4>
        </c>
    </b>
    <bbbb>
        <!--this is comment-->
        <k apple="5"/>
    </bbbb>
</a>
```

### SVG Example

```rust
use tagu::build;
use tagu::prelude::*;

fn main() -> std::fmt::Result {
    let width = 100.0;
    let height = 100.0;

    let rect = build::single("rect").with(attrs!(
        ("x1", 0),
        ("y1", 0),
        ("rx", 20),
        ("ry", 20),
        ("width", width),
        ("height", height),
        ("style", "fill:blue")
    ));

    let style = build::elem("style")
        .inline()
        .append(build::raw(".test{fill:none;stroke:white;stroke-width:3}"));

    let svg = build::elem("svg").with(attrs!(
        ("xmlns", "http://www.w3.org/2000/svg"),
        ("viewBox", format_move!("0 0 {} {}", width, height))
    ));

    let rows = build::from_stack(|mut f| {
        for r in (0..50).step_by(5) {
            if r % 10 == 0 {
                let c = build::single("circle").with(attrs!(("cx", 50.0), ("cy", 50.0), ("r", r)));
                f.put(c)?;
            } else {
                let r = build::single("rect").with(attrs!(
                    ("x", 50 - r),
                    ("y", 50 - r),
                    ("width", r * 2),
                    ("height", r * 2)
                ));
                f.put(r)?;
            }
        }
        Ok(f)
    });

    let table = build::elem("g").with(("class", "test")).append(rows);

    let all = svg.append(style).append(rect).append(table);

    tagu::render(all, tagu::stdout_fmt())
}
```

### Output

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <style>.test{fill:none;stroke:white;stroke-width:3}</style>
    <rect x1="0" y1="0" rx="20" ry="20" width="100" height="100" style="fill:blue"/>
    <g class="test">
            <circle cx="50" cy="50" r="0"/>
            <rect x="45" y="45" width="10" height="10"/>
            <circle cx="50" cy="50" r="10"/>
            <rect x="35" y="35" width="30" height="30"/>
            <circle cx="50" cy="50" r="20"/>
            <rect x="25" y="25" width="50" height="50"/>
            <circle cx="50" cy="50" r="30"/>
            <rect x="15" y="15" width="70" height="70"/>
            <circle cx="50" cy="50" r="40"/>
            <rect x="5" y="5" width="90" height="90"/>
    </g>
</svg>
```



See other example outputs at [https://github.com/tiby312/tagu/tree/main/assets](https://github.com/tiby312/tagu/tree/main/assets)



### Which method to use?

You can append elements via building of long adaptor chains, or you can render
elements to a writer on the fly. With chaining,
you don't have to worry about handling errors because nothing actually gets written out
as you're chaining. However, you do tend to have to build things 'upside down'. You have to build
the elements thats are the most nested first, and then you can append that to bigger and bigger elements.
With rendering on the fly, yeah you have to handle errors, but the order in which elements are handled
matches how they are rendered.
You can mix and match because you can make elements from closures and then chain those elements together.

### Inline function

By default tags insertion newlines and tabs. If you call `inline()` on an element, all elements
within it will be inlined. 

### Is there escape XML protection?

Attributes are fed through a escape protectors. Tag names are fed through escape protectors. 
User can bypass this using the `raw_escpapable()` or `from_stack_escapable()` functions. This returns the only element type that doesnt implement `elem::Locked`.
`render()` requires that the chained together element implements `Locked`. If the user chains in a raw element, the whole
chain will not implement `Locked`. Instead the user would have to use `render_escapable()`. The element chaining system works by having each element implement a `render_head()`, and a `render_tail()` function.

### What happened to the tagger crate?

I left the tagger crate alone and made this into a brand new crate because while it does have all
the functionality of tagger, it is more complicated. Some people might just like the simplicity of tagger. However, I recommend people choose tagu over tagger, because I think its a lot more flexible. The ability to pass around element chains like structs is really useful in my experience.