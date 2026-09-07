use ::ascii_table::{Align, AsciiTable, Column};

use ::std::fmt::Display;

#[test]
fn protect_public_api() {
    let mut table = AsciiTable::default();

    let _: &mut AsciiTable = table.set_max_width(10usize);
    let _: usize = table.max_width();

    let _: &mut Column = table.column(0usize).set_header("HEADER");
    let _: &mut Column = table.column(0usize).set_header("HEADER".to_string());
    let _: &str = table.column(0usize).header();

    let _: &mut Column = table.column(0usize).set_align(Align::Left);
    let _: Align = table.column(0usize).align();

    let _: &mut Column = table.column(0usize).set_max_width(10usize);
    let _: usize = table.column(0usize).max_width();

    table.print(Vec::<Vec<&dyn Display>>::new());
    table.print(Vec::<Vec<String>>::new());
    table.print(Vec::<Vec<&str>>::new());
    table.print(Vec::<&[&dyn Display]>::new());
    table.print(Vec::<&[String]>::new());
    table.print(Vec::<&[&str]>::new());
    table.print(<&[Vec<&dyn Display>]>::default());
    table.print(<&[Vec<String>]>::default());
    table.print(<&[Vec<&str>]>::default());

    let _ = table.clone();
    let _ = table == table;
    println!("{table:?}");

    match Align::Left {
        Align::Left => (),
        Align::Center => (),
        Align::Right => (),
    };
}
