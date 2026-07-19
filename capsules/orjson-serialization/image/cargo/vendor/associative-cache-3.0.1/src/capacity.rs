//! Constant cache capacity implementations.

use super::Capacity;

macro_rules! define_capacity {
    ( $( $(#[$attr:meta])* $name:ident => $n:expr; )* ) => {
        $(
            $( #[$attr] )*
            #[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
            pub struct $name;

            impl Capacity for $name {
                const CAPACITY: usize = $n;
            }
        )*
    }
}

define_capacity! {
    /// Constant cache capacity = 1.
    Capacity1 => 1;
    /// Constant cache capacity = 2.
    Capacity2 => 2;
    /// Constant cache capacity = 4.
    Capacity4 => 4;
    /// Constant cache capacity = 8.
    Capacity8 => 8;
    /// Constant cache capacity = 16.
    Capacity16 => 16;
    /// Constant cache capacity = 32.
    Capacity32 => 32;
    /// Constant cache capacity = 64.
    Capacity64 => 64;
    /// Constant cache capacity = 128.
    Capacity128 => 128;
    /// Constant cache capacity = 256.
    Capacity256 => 256;
    /// Constant cache capacity = 512.
    Capacity512 => 512;
    /// Constant cache capacity = 1024.
    Capacity1024 => 1024;
    /// Constant cache capacity = 2048.
    Capacity2048 => 2048;
    /// Constant cache capacity = 4096.
    Capacity4096 => 4096;
    /// Constant cache capacity = 8192.
    Capacity8192 => 8192;
}
