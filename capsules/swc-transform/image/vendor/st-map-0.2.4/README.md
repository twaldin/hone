# st-map

Stack-allocated map.

## Usage

```rust
use st_map::StaticMap;

#[derive(Debug, PartialEq, Default, StaticMap)]
struct BrowserData<T: Default> {
    chrome: T,
    safari: T,
    android: T,
}

#[test]
fn usage_iter() {
    let mut data = BrowserData {
        chrome: true,
        safari: false,
        android: true,
    };
    assert_eq!(
        data.iter().collect::<Vec<_>>(),
        vec![("chrome", &true), ("safari", &false), ("android", &true),]
    );

    assert_eq!(
        data.iter_mut().collect::<Vec<_>>(),
        vec![
            ("chrome", &mut true),
            ("safari", &mut false),
            ("android", &mut true),
        ]
    );

    assert_eq!(
        data.into_iter().collect::<Vec<_>>(),
        vec![("chrome", true), ("safari", false), ("android", true),]
    );
}

#[test]
fn usage_map() {
    let data = BrowserData {
        chrome: 20000,
        safari: 10000,
        ..Default::default()
    };

    assert_eq!(
        data.map_value(|v| v > 15000),
        BrowserData {
            chrome: true,
            safari: false,
            android: false,
        }
    );
}

```

# License

Apache-2.0
