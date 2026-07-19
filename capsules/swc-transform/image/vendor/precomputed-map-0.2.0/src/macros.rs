#[macro_export]
macro_rules! define {
    ( $vis:vis const $name:ident: &[u8; $n:expr] = include $path:literal ) => {
        $vis struct $name;

        impl $crate::store::AsData for $name {
            type Data = [u8; $n];

            fn as_data() -> &'static Self::Data {
                const VALUE: &[u8; $n] = include_bytes!($path);
                VALUE
            }
        }
    };
    ( $vis:vis const $name:ident: &[u8 align $unit:ty; $n:expr] = include $path:literal ) => {
        $vis struct $name;

        impl $crate::store::AsData for $name {
            type Data = [u8; $n];

            fn as_data() -> &'static Self::Data {
                static VALUE: &$crate::aligned::AlignedBytes<$n, $unit> = &$crate::aligned::AlignedBytes {
                    align: [],
                    bytes: *include_bytes!($path)
                };

                &VALUE.bytes
            }
        }
    };
    ( $vis:vis const searchable $name:ident: &[$unit:ty; $n:expr] = $v:expr ) => {
        $crate::define!($vis const $name: &[$unit; $n] = $v );

        impl $crate::store::Searchable for $name {
            fn search<Q>(query: &Q)
                -> Option<Self::Value>
            where
                Q: $crate::equivalent::Comparable<Self::Key> + ?Sized
            {
                let values = $name.as_slice();
                values.binary_search_by(|k| query.compare(k).reverse()).ok()
            }
        }        
    };
    ( $vis:vis const $name:ident: &[$unit:ty; $n:expr] = $v:expr ) => {
        $vis struct $name;

        impl $name {
            fn as_slice(&self) -> &[$unit] {
                static VALUE: &[$unit; $n] = $v;
                VALUE
            }
        }

        impl $crate::store::AccessSeq for $name {
            type Item = $unit;
            const LEN: usize = $n;

            fn index(index: usize) -> Option<Self::Item> {
                $name.as_slice().get(index).copied()
            }
        }
    }
}
