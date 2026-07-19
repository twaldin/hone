use core::mem::MaybeUninit;
use munge::munge;

fn main() {
    struct Struct {
        a: u32,
        b: u32,
    }

    let mut mu = MaybeUninit::<Struct>::uninit();

    munge!(let Struct { a, .. } = mu);

    struct Tuple(u32, u32);

    let mut mu = MaybeUninit::<Tuple>::uninit();

    munge!(let Tuple(a, ..) = mu);
}
