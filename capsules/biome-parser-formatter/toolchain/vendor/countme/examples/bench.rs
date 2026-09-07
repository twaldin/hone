use std::thread;

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
    let n = 5;
    let m = 1_000_000;

    let mut threads = Vec::new();
    for _ in 0..n {
        threads.push(thread::spawn(move || {
            for _ in 0..m {
                Foo::default();
            }
        }));
        threads.push(thread::spawn(move || {
            let mut xs = Vec::with_capacity(m);
            for _ in 0..m {
                xs.push(Bar::default())
            }
        }));
        threads.push(thread::spawn(move || {
            for _ in 0..m {
                deeply::nested::module::Quux::default();
            }
        }));
    }
    for t in threads {
        t.join().unwrap();
    }

    let foo = get::<Foo>();
    assert_eq!(foo.total, m * n);
    assert!(foo.max_live >= 1);
    assert_eq!(foo.live, 0);

    let bar = get::<Bar>();
    assert_eq!(bar.total, m * n);
    assert!(bar.max_live >= m);
    assert_eq!(bar.live, 0);

    println!("{:?}", t.elapsed());
}
