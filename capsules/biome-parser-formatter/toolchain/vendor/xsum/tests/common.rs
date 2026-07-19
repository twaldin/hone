use xsum::{Xsum, XsumAuto, XsumExt, XsumLarge, XsumSmall, XsumVariant};

fn is_valid(actual: f64, expected: f64) -> bool {
    // check NaN, 0, -0, infinity, -infinity, finite values
    if actual.to_bits() == expected.to_bits() {
        return true;
    }

    // check NaN with no payload
    if actual.is_nan() && expected.is_nan() {
        return true;
    }
    false
}

pub(crate) fn same_value(vec: &[f64], expected: f64) {
    // XsumSmall
    let mut xsumsmall = XsumSmall::new();
    xsumsmall.add_list(vec);
    assert!(is_valid(xsumsmall.sum(), expected));

    xsumsmall.clear();
    assert!(is_valid(xsumsmall.sum(), -0.0));

    for &val in vec {
        xsumsmall.add(val);
    }
    assert!(is_valid(xsumsmall.sum(), expected));

    // XsumLarge
    let mut xsumlarge = XsumLarge::new();
    xsumlarge.add_list(vec);
    assert!(is_valid(xsumlarge.sum(), expected));

    xsumlarge.clear();
    assert!(is_valid(xsumlarge.sum(), -0.0));

    for &val in vec {
        xsumlarge.add(val);
    }
    assert!(is_valid(xsumlarge.sum(), expected));

    // XsumAuto
    let mut xsumauto = XsumAuto::new();
    xsumauto.add_list(vec);
    assert!(is_valid(xsumauto.sum(), expected));

    xsumauto.clear();
    assert!(is_valid(xsumauto.sum(), -0.0));

    for &val in vec {
        xsumauto.add(val);
    }
    assert!(is_valid(xsumauto.sum(), expected));

    // XsumVariant
    let mut xsumvariant = if vec.len() <= 3 {
        XsumVariant::Small(XsumSmall::new())
    } else if vec.len() <= 5 {
        XsumVariant::Large(XsumLarge::new())
    } else {
        XsumVariant::Auto(XsumAuto::new())
    };
    xsumvariant.add_list(vec);
    assert!(is_valid(xsumvariant.sum(), expected));

    xsumvariant.clear();
    assert!(is_valid(xsumvariant.sum(), -0.0));

    for &val in vec {
        xsumvariant.add(val);
    }
    assert!(is_valid(xsumvariant.sum(), expected));

    // XsumExt
    assert!(is_valid(vec.xsum(), expected));
}
