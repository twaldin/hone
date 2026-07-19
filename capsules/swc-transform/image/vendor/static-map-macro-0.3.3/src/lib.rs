extern crate proc_macro;

use std::iter::once;

use proc_macro2::{Span, TokenStream};
use quote::{quote, ToTokens};
use syn::{
    parse, parse_quote, punctuated::Punctuated, token::Comma, Arm, Data, DeriveInput, Expr,
    ExprMatch, Field, FieldValue, Fields, GenericParam, Generics, Ident, Item, ItemImpl, Lit,
    LitStr, Pat, PatLit, Token, Type,
};

use self::util::ItemImplExt;

mod util;

enum Mode {
    Value,
    Ref,
    MutRef,
}

#[proc_macro_derive(StaticMap)]
pub fn derive(input: proc_macro::TokenStream) -> proc_macro::TokenStream {
    let input = parse::<DeriveInput>(input).expect("failed to parse input as DeriveInput");
    let name = input.ident.clone();

    let fields = match input.data {
        Data::Struct(s) => {
            if s.fields.is_empty() {
                panic!("StaticMap: failed to detect type because there's no field")
            }

            match s.fields {
                Fields::Named(named) => named.named,
                _ => panic!("StaticMap: failed to detect type because there's no field"),
            }
        }
        _ => panic!("StaticMap can only be applied to structs"),
    };
    let len = fields.len();
    let data_type = fields.first().unwrap().ty.clone();

    let (_impl_generics, ty_generics, _where_clause) = input.generics.split_for_impl();

    let mut tts = TokenStream::new();

    let type_name = parse_quote!(#name #ty_generics);

    {
        // IntoIterator

        let make = |m: Mode| {
            let arr: Punctuated<_, Token![;]> = fields
                .iter()
                .map(|f| -> Expr {
                    //
                    let name = f.ident.as_ref().unwrap();
                    let mode = match m {
                        Mode::Value => quote!(),
                        Mode::Ref => quote!(&),
                        Mode::MutRef => quote!(&mut),
                    };
                    let value = f.ident.as_ref().unwrap();

                    parse_quote!(
                        v.push((stringify!(#name), #mode self.#value))
                    )
                })
                .collect();

            arr
        };

        let body = make(Mode::Value);

        let item: ItemImpl = parse_quote!(
            impl IntoIterator for #name {
                type IntoIter = st_map::arrayvec::IntoIter<(&'static str, #data_type), #len>;
                type Item = (&'static str, #data_type);

                fn into_iter(self) -> Self::IntoIter {
                    let mut v: st_map::arrayvec::ArrayVec<_, #len> = Default::default();

                    #body;

                    v.into_iter()
                }
            }
        );

        item.with_generics(input.generics.clone())
            .to_tokens(&mut tts);
    }

    {
        // Iterators

        let mut items = vec![];

        items.extend(make_iterator(
            &type_name,
            &data_type,
            &Ident::new(&format!("{name}RefIter"), Span::call_site()),
            &fields,
            &input.generics,
            Mode::Ref,
        ));
        items.extend(make_iterator(
            &type_name,
            &data_type,
            &Ident::new(&format!("{name}MutIter"), Span::call_site()),
            &fields,
            &input.generics,
            Mode::MutRef,
        ));

        for item in items {
            item.to_tokens(&mut tts);
        }
    }

    {
        // std::ops::Index
        let body = ExprMatch {
            attrs: Default::default(),
            match_token: Default::default(),
            expr: parse_quote!(v),
            brace_token: Default::default(),
            arms: fields
                .iter()
                .map(|f| {
                    let variant = &f.ident;
                    //
                    Arm {
                        attrs: Default::default(),
                        pat: Pat::Lit(PatLit {
                            attrs: Default::default(),
                            lit: Lit::Str(LitStr::new(
                                &f.ident.as_ref().unwrap().to_string(),
                                Span::call_site(),
                            )),
                        }),
                        guard: None,
                        fat_arrow_token: Default::default(),
                        body: parse_quote!(&self.#variant),
                        comma: Some(Default::default()),
                    }
                })
                .chain(once(parse_quote!(
                    _ => panic!("Unknown key: {}", v),
                )))
                .collect(),
        };

        let item: ItemImpl = parse_quote!(
            impl<'a, K: ?Sized + ::std::borrow::Borrow<str>> ::std::ops::Index<&'a K> for #name {
                type Output = #data_type;
                fn index(&self, v: &K) -> &Self::Output {
                    use std::borrow::Borrow;
                    let v: &str = v.borrow();
                    #body
                }
            }
        );
        item.with_generics(input.generics.clone())
            .to_tokens(&mut tts);
    }

    {
        assert!(
            input.generics.params.is_empty() || input.generics.params.len() == 1,
            "StaticMap should have zero or one generic argument"
        );

        let map_fields: Punctuated<_, Token![,]> = fields
            .iter()
            .map(|f| -> FieldValue {
                let f = f.ident.as_ref().unwrap();
                let f_str = f.to_string();
                parse_quote!(
                    #f: op(#f_str, self.#f)
                )
            })
            .collect();

        // map(), map_value()
        let item = if input.generics.params.is_empty() {
            quote!(
                impl #name {
                    pub fn map(self, mut op: impl FnMut(&'static str, #data_type) -> #data_type) -> #name {
                        #name { #map_fields }
                    }

                    #[inline]
                    pub fn map_value(self, mut op: impl FnMut(#data_type) -> #data_type) -> #name {
                        self.map(|_, v| op(v))
                    }
                }
            )
        } else if match input.generics.params.first().as_ref().unwrap() {
            GenericParam::Type(ty) => ty.bounds.is_empty(),
            _ => false,
        } {
            quote!(
                impl<T> #name<T> {
                    pub fn map<N>(self, mut op: impl FnMut(&'static str, #data_type) -> N) -> #name<N> {
                        #name { #map_fields }
                    }

                    #[inline]
                    pub fn map_value<N>(self, mut op: impl FnMut(#data_type) -> N) -> #name<N> {
                        self.map(|_, v| op(v))
                    }
                }
            )
        } else {
            let bound = match input.generics.params.first().as_ref().unwrap() {
                GenericParam::Type(ty) => &ty.bounds,
                _ => unimplemented!("Generic parameters other than type parameter"),
            };

            quote!(
                impl<#data_type: #bound> #name<#data_type> {
                    pub fn map<N: #bound>(
                        self,
                        mut op: impl FnMut(&'static str, #data_type) -> N,
                    ) -> #name<N> {
                        #name { #map_fields }
                    }

                    #[inline]
                    pub fn map_value<N: #bound>(self, mut op: impl FnMut(#data_type) -> N) -> #name<N> {
                        self.map(|_, v| op(v))
                    }
                }
            )
        };

        item.to_tokens(&mut tts);
    }

    tts.into()
}

fn make_iterator(
    type_name: &Type,
    data_type: &Type,
    iter_type_name: &Ident,
    fields: &Punctuated<Field, Comma>,
    generic: &Generics,
    mode: Mode,
) -> Vec<Item> {
    let len = fields.len();

    let (impl_generics, _, _) = generic.split_for_impl();

    let where_clause = generic.where_clause.clone();

    let type_generic = {
        let type_generic = generic.params.last();
        match type_generic {
            Some(GenericParam::Type(t)) => {
                let param_name = t.ident.clone();
                let bounds = if t.bounds.is_empty() {
                    quote!()
                } else {
                    let b = &t.bounds;
                    quote!(: #b)
                };

                match mode {
                    Mode::Value => quote!(<#param_name #bounds>),
                    Mode::Ref => quote!(<'a, #param_name #bounds>),
                    Mode::MutRef => quote!(<'a, #param_name #bounds>),
                }
            }
            _ => match mode {
                Mode::Value => quote!(),
                Mode::Ref => quote!(<'a>),
                Mode::MutRef => quote!(<'a>),
            },
        }
    };

    let generic_arg_for_method = {
        let type_generic = generic.params.last();
        match type_generic {
            Some(GenericParam::Type(t)) => {
                let param_name = t.ident.clone();

                quote!(<#param_name>)
            }
            _ => quote!(),
        }
    };

    let generic = {
        let type_generic = generic.params.last();
        match type_generic {
            Some(GenericParam::Type(t)) => {
                let param_name = t.ident.clone();

                match mode {
                    Mode::Value => quote!(<#param_name>),
                    Mode::Ref => quote!(<'a, #param_name>),
                    Mode::MutRef => quote!(<'a, #param_name>),
                }
            }
            _ => match mode {
                Mode::Value => quote!(),
                Mode::Ref => quote!(<'a>),
                Mode::MutRef => quote!(<'a>),
            },
        }
    };

    let lifetime = match mode {
        Mode::Value => quote!(),
        Mode::Ref => quote!(&'a),
        Mode::MutRef => quote!(&'a mut),
    };

    let arms = fields
        .iter()
        .enumerate()
        .map(|(idx, f)| {
            let pat = idx + 1;

            let name = f.ident.as_ref().unwrap();
            let name_str = name.to_string();
            match mode {
                Mode::Value => quote!(#pat => Some((#name_str, self.data.#name))),
                Mode::Ref => quote!(#pat => Some((#name_str, &self.data.#name))),
                Mode::MutRef => quote!(#pat => Some((#name_str, unsafe {
                    std::mem::transmute::<&mut _, &'a mut _>(&mut self.data.#name)
                }))),
            }
        })
        .collect::<Punctuated<_, Comma>>();

    let iter_type = parse_quote!(
        pub struct #iter_type_name #type_generic {
            cur_index: usize,
            data: #lifetime #type_name,
        }
    );
    let mut iter_impl: ItemImpl = parse_quote!(
        impl #type_generic Iterator for #iter_type_name #generic {
            type Item = (&'static str, #lifetime #data_type);

            fn next(&mut self) -> Option<Self::Item> {
                self.cur_index += 1;
                match self.cur_index {
                    #arms,

                    _ => None
                }
            }

            fn size_hint(&self) -> (usize, Option<usize>) {
                let len = #len - self.cur_index;
                (len, Some(len))
            }
        }
    );
    iter_impl.generics.where_clause = where_clause;

    let impl_for_method = {
        let (recv, method_name) = match mode {
            Mode::Value => (quote!(self), quote!(into_iter)),
            Mode::Ref => (quote!(&self), quote!(iter)),
            Mode::MutRef => (quote!(&mut self), quote!(iter_mut)),
        };

        parse_quote! {
            impl #impl_generics #type_name {
                pub fn #method_name(#recv) -> #iter_type_name #generic_arg_for_method {
                    #iter_type_name {
                        cur_index: 0,
                        data: self,
                    }
                }
            }
        }
    };

    vec![iter_type, Item::Impl(iter_impl), impl_for_method]
}
