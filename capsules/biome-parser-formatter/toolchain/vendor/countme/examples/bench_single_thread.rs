use countme::{get, Count};

#[derive(Default)]
struct Foo {
    _c: Count<Self>,
}

#[derive(Default)]
struct Bar {
    _c: Count<Self>,
    _x: i32,
}

mod deeply {
    pub(crate) mod nested {
        pub(crate) mod module {
            use countme::Count;

            #[derive(Default)]
            pub(crate) struct Quux {
                _c: Count<Self>,
            }
        }
    }
}

fn main() {
    countme::enable(true);
    let t = std::time::Instant::now();
    let n = 6;
    let m = 2_000_000;

    for _ in 0..n {
        for _ in 0..m {
            Foo::default();
        }

        let mut xs = Vec::with_capacity(m);
        for _ in 0..m {
            xs.push(Bar::default())
        }

        for _ in 0..m {
            deeply::nested::module::Quux::default();
        }

        let fs = [
            || drop(Foo::default()),
            || drop(Bar::default()),
            || drop(deeply::nested::module::Quux::default()),
            || {
                #[derive(Default)]
                struct Local(Count<Self>);

                Local::default();
            },
        ];
        for i in 0..m {
            fs[i % 4]();
        }
    }

    let foo = get::<Foo>();
    assert_eq!(foo.total, m * n + (m * n / 4));
    assert_eq!(foo.max_live, 1);
    assert_eq!(foo.live, 0);

    let bar = get::<Bar>();
    assert_eq!(bar.total, m * n + (m * n / 4));

    // FIXME: why +1? This seems like a bug
    // overreporting by 1 is not significant, but anyway
    assert_eq!(bar.max_live, m + 1);
    assert_eq!(bar.live, 0);

    println!("{:?}", t.elapsed());
}
