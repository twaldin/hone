// Large enough to contain any enumeration name defined in this crate
pub type PascalCaseBuf = [u8; 32];

pub const fn fmt_pascal_case_const(name: &str) -> (PascalCaseBuf, usize) {
    let mut buf = [0; 32];
    let mut buf_i = 0;
    let mut name_i = 0;
    let name = name.as_bytes();
    while name_i < name.len() {
        let first = name[name_i];
        name_i += 1;

        buf[buf_i] = first;
        buf_i += 1;

        while name_i < name.len() {
            let rest = name[name_i];
            name_i += 1;
            if rest == b'_' {
                break;
            }

            buf[buf_i] = rest.to_ascii_lowercase();
            buf_i += 1;
        }
    }
    (buf, buf_i)
}

pub fn fmt_pascal_case(f: &mut std::fmt::Formatter<'_>, name: &str) -> std::fmt::Result {
    for word in name.split('_') {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            write!(f, "{first}")?;
        }
        for rest in chars {
            write!(f, "{}", rest.to_lowercase())?;
        }
    }
    Ok(())
}

// ```
// struct SpecificCode(i32);
//
// lsp_enum! {
//   impl SpecificCode {
//     const FOO = 1;
//     const BAR = 2;
//   }
// }
// ```
macro_rules! lsp_enum {
    (
        impl $typ: ident {
            $(
                $(#[$attr:meta])*
                const $name:ident = $value:expr;
            )*
        }
    ) => {
        impl $typ {
            $(
                $(#[$attr])*
                pub const $name: $typ = $typ($value);
            )*
        }

        impl std::fmt::Debug for $typ {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                match *self {
                    $(
                        Self::$name => crate::macros::fmt_pascal_case(f, stringify!($name)),
                    )*
                    _ => write!(f, "{}({})", stringify!($typ), self.0),
                }
            }
        }

        impl std::convert::TryFrom<&str> for $typ {
            type Error = &'static str;
            fn try_from(value: &str) -> Result<Self, Self::Error> {
                match () {
                    $(
                        _ if {
                            const X: (crate::macros::PascalCaseBuf, usize) = crate::macros::fmt_pascal_case_const(stringify!($name));
                            let (buf, len) = X;
                            &buf[..len] == value.as_bytes()
                        } => Ok(Self::$name),
                    )*
                    _ => Err("unknown enum variant"),
                }
            }
        }

    }
}

pub(crate) use lsp_enum;
