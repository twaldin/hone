#[cfg(feature = "color_codes")]
use ::colorful::{Color, Colorful};

use crate::Align::*;
use crate::AsciiTable;

use ::std::fmt::Display;

fn cube_config() -> AsciiTable {
    let mut result = AsciiTable::default();
    result.column(0).set_header("a");
    result.column(1).set_header("b");
    result.column(2).set_header("c");
    result
}

#[test]
fn empty_rows() {
    let config = AsciiTable::default();
    let input: Vec<Vec<i32>> = vec![];
    let expected = "┌──┐\n\
                    │  │\n\
                    └──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn empty_columns() {
    let config = AsciiTable::default();
    let input: Vec<Vec<i32>> = vec![vec![]];
    let expected = "┌──┐\n\
                    │  │\n\
                    └──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn cube_with_header() {
    let config = cube_config();
    let input = vec![&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]];
    let expected = "┌───┬───┬───┐\n\
                    │ a │ b │ c │\n\
                    ├───┼───┼───┤\n\
                    │ 1 │ 2 │ 3 │\n\
                    │ 4 │ 5 │ 6 │\n\
                    │ 7 │ 8 │ 9 │\n\
                    └───┴───┴───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn cube_with_no_header() {
    let config = AsciiTable::default();
    let input = vec![&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]];
    let expected = "┌───┬───┬───┐\n\
                    │ 1 │ 2 │ 3 │\n\
                    │ 4 │ 5 │ 6 │\n\
                    │ 7 │ 8 │ 9 │\n\
                    └───┴───┴───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn one_cell() {
    let config = AsciiTable::default();
    let input = vec![&[1]];
    let expected = "┌───┐\n\
                    │ 1 │\n\
                    └───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn smallest_cell() {
    let mut config = AsciiTable::default();
    config.set_max_width(4);

    let input = vec![&[123]];
    let expected = "┌──┐\n\
                    │  │\n\
                    └──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn smallest_cell2() {
    let mut config = AsciiTable::default();
    config.column(0).set_max_width(0);

    let input = vec![&[123]];
    let expected = "┌──┐\n\
                    │  │\n\
                    └──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn smallest_cube() {
    let mut config = AsciiTable::default();
    config.set_max_width(10);

    let input = vec![&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]];
    let expected = "┌──┬──┬──┐\n\
                    │  │  │  │\n\
                    │  │  │  │\n\
                    │  │  │  │\n\
                    └──┴──┴──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn smallest_cube2() {
    let mut config = AsciiTable::default();
    config.column(0).set_max_width(0);
    config.column(1).set_max_width(0);
    config.column(2).set_max_width(0);

    let input = vec![&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]];
    let expected = "┌──┬──┬──┐\n\
                    │  │  │  │\n\
                    │  │  │  │\n\
                    │  │  │  │\n\
                    └──┴──┴──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn show_no_content_for_cell() {
    let mut config = AsciiTable::default();
    config.set_max_width(5);

    let input = vec![&[123]];
    let expected = "┌───┐\n\
                    │ + │\n\
                    └───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn show_no_content_for_cell2() {
    let mut config = AsciiTable::default();
    config.column(0).set_max_width(1);

    let input = vec![&[123]];
    let expected = "┌───┐\n\
                    │ + │\n\
                    └───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn show_one_character_for_cell() {
    let mut config = AsciiTable::default();
    config.set_max_width(6);

    let input = vec![&[123]];
    let expected = "┌────┐\n\
                    │ 1+ │\n\
                    └────┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn show_one_character_for_cell2() {
    let mut config = AsciiTable::default();
    config.column(0).set_max_width(2);

    let input = vec![&[123]];
    let expected = "┌────┐\n\
                    │ 1+ │\n\
                    └────┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn smallest_cell_with_header() {
    let mut config = AsciiTable::default();
    config.set_max_width(4);
    config.column(0).set_header("foo");

    let input = vec![&[123]];
    let expected = "┌──┐\n\
                    │  │\n\
                    ├──┤\n\
                    │  │\n\
                    └──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn smallest_cell_with_header2() {
    let mut config = AsciiTable::default();
    config.column(0).set_max_width(0).set_header("foo");

    let input = vec![&[123]];
    let expected = "┌──┐\n\
                    │  │\n\
                    ├──┤\n\
                    │  │\n\
                    └──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn smallest_cube_with_header() {
    let mut config = AsciiTable::default();
    config.set_max_width(10);
    config.column(0).set_header("abc");
    config.column(1).set_header("def");
    config.column(2).set_header("ghi");

    let input = vec![&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]];
    let expected = "┌──┬──┬──┐\n\
                    │  │  │  │\n\
                    ├──┼──┼──┤\n\
                    │  │  │  │\n\
                    │  │  │  │\n\
                    │  │  │  │\n\
                    └──┴──┴──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn smallest_cube_with_header2() {
    let mut config = AsciiTable::default();
    config.column(0).set_header("abc").set_max_width(0);
    config.column(1).set_header("def").set_max_width(0);
    config.column(2).set_header("ghi").set_max_width(0);

    let input = vec![&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]];
    let expected = "┌──┬──┬──┐\n\
                    │  │  │  │\n\
                    ├──┼──┼──┤\n\
                    │  │  │  │\n\
                    │  │  │  │\n\
                    │  │  │  │\n\
                    └──┴──┴──┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn show_no_content_for_header() {
    let mut config = AsciiTable::default();
    config.set_max_width(5);
    config.column(0).set_header("abc");

    let input = vec![&[""]];
    let expected = "┌───┐\n\
                    │ + │\n\
                    ├───┤\n\
                    │   │\n\
                    └───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn show_no_content_for_header2() {
    let mut config = AsciiTable::default();
    config.column(0).set_header("abc").set_max_width(1);

    let input = vec![&[""]];
    let expected = "┌───┐\n\
                    │ + │\n\
                    ├───┤\n\
                    │   │\n\
                    └───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn show_one_character_for_header() {
    let mut config = AsciiTable::default();
    config.set_max_width(6);
    config.column(0).set_header("abc");

    let input = vec![&[""]];
    let expected = "┌────┐\n\
                    │ a+ │\n\
                    ├────┤\n\
                    │    │\n\
                    └────┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn show_one_character_for_header2() {
    let mut config = AsciiTable::default();
    config.column(0).set_header("abc").set_max_width(2);

    let input = vec![&[""]];
    let expected = "┌────┐\n\
                    │ a+ │\n\
                    ├────┤\n\
                    │    │\n\
                    └────┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn cube_with_partial_content() {
    let config = cube_config();
    let input: Vec<&[i32]> = vec![&[1, 2, 3], &[4, 5], &[7]];
    let expected = "┌───┬───┬───┐\n\
                    │ a │ b │ c │\n\
                    ├───┼───┼───┤\n\
                    │ 1 │ 2 │ 3 │\n\
                    │ 4 │ 5 │   │\n\
                    │ 7 │   │   │\n\
                    └───┴───┴───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn cube_with_partial_content_reversed() {
    let config = cube_config();
    let input: Vec<&[i32]> = vec![&[1], &[4, 5], &[7, 8, 9]];
    let expected = "┌───┬───┬───┐\n\
                    │ a │ b │ c │\n\
                    ├───┼───┼───┤\n\
                    │ 1 │   │   │\n\
                    │ 4 │ 5 │   │\n\
                    │ 7 │ 8 │ 9 │\n\
                    └───┴───┴───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn resize_column() {
    let config = cube_config();
    let input = vec![&[1], &[23], &[456]];
    let expected = "┌─────┐\n\
                    │ a   │\n\
                    ├─────┤\n\
                    │ 1   │\n\
                    │ 23  │\n\
                    │ 456 │\n\
                    └─────┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn resize_column_reversed() {
    let config = cube_config();
    let input = vec![&[123], &[45], &[6]];
    let expected = "┌─────┐\n\
                    │ a   │\n\
                    ├─────┤\n\
                    │ 123 │\n\
                    │ 45  │\n\
                    │ 6   │\n\
                    └─────┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn resize_column_via_header() {
    let mut config = AsciiTable::default();
    config.column(0).set_header("foo");

    let input = vec![&[1], &[2], &[3]];
    let expected = "┌─────┐\n\
                    │ foo │\n\
                    ├─────┤\n\
                    │ 1   │\n\
                    │ 2   │\n\
                    │ 3   │\n\
                    └─────┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn partial_header_at_start() {
    let config = cube_config();
    let input = vec![&[1, 2, 3, 0], &[4, 5, 6, 0], &[7, 8, 9, 0]];
    let expected = "┌───┬───┬───┬───┐\n\
                    │ a │ b │ c │   │\n\
                    ├───┼───┼───┼───┤\n\
                    │ 1 │ 2 │ 3 │ 0 │\n\
                    │ 4 │ 5 │ 6 │ 0 │\n\
                    │ 7 │ 8 │ 9 │ 0 │\n\
                    └───┴───┴───┴───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn partial_header_at_end() {
    let mut config = AsciiTable::default();
    config.column(2).set_header("c");

    let input = vec![&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]];
    let expected = "┌───┬───┬───┐\n\
                    │   │   │ c │\n\
                    ├───┼───┼───┤\n\
                    │ 1 │ 2 │ 3 │\n\
                    │ 4 │ 5 │ 6 │\n\
                    │ 7 │ 8 │ 9 │\n\
                    └───┴───┴───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn ignore_unused_header() {
    let config = cube_config();
    let input = vec![&[1], &[2], &[3]];
    let expected = "┌───┐\n\
                    │ a │\n\
                    ├───┤\n\
                    │ 1 │\n\
                    │ 2 │\n\
                    │ 3 │\n\
                    └───┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn align_right() {
    let mut config = AsciiTable::default();
    config.column(0).set_header("a").set_align(Right);

    let input = vec![&[1], &[23], &[456]];
    let expected = "┌─────┐\n\
                    │ a   │\n\
                    ├─────┤\n\
                    │   1 │\n\
                    │  23 │\n\
                    │ 456 │\n\
                    └─────┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn align_center() {
    let mut config = AsciiTable::default();
    config.column(0).set_header("a").set_align(Center);

    let input = vec![&[1], &[23], &[456], &[7890], &[12345]];
    let expected = "┌───────┐\n\
                    │ a     │\n\
                    ├───────┤\n\
                    │   1   │\n\
                    │  23   │\n\
                    │  456  │\n\
                    │ 7890  │\n\
                    │ 12345 │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[test]
fn mixed_types() {
    let config = cube_config();
    let input: Vec<Vec<&dyn Display>> = vec![
        vec![&1, &'2', &"3"],
        vec![&"4", &5, &'6'],
        vec![&'7', &"8", &9],
    ];
    let expected = "┌───┬───┬───┐\n\
                    │ a │ b │ c │\n\
                    ├───┼───┼───┤\n\
                    │ 1 │ 2 │ 3 │\n\
                    │ 4 │ 5 │ 6 │\n\
                    │ 7 │ 8 │ 9 │\n\
                    └───┴───┴───┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_zero() {
    let config = AsciiTable::default();
    let input = vec![vec!["\u{1b}[0mHello\u{1b}[0m"]];
    let expected = "┌───────┐\n\
                    │ \u{1b}[0mHello\u{1b}[0m │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_zero_inbetween() {
    let config = AsciiTable::default();
    let input = vec![vec!["He\u{1b}[0ml\u{1b}[0mlo"]];
    let expected = "┌───────┐\n\
                    │ He\u{1b}[0ml\u{1b}[0mlo │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_m5() {
    let config = AsciiTable::default();
    let input = vec![vec![
        "mmmmm".color(Color::Blue).bg_color(Color::Yellow).bold(),
    ]];
    let expected = "┌───────┐\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1mmmmmm\u{1b}[0m │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_b5() {
    let config = AsciiTable::default();
    let input = vec![vec![
        "[[[[[".color(Color::Blue).bg_color(Color::Yellow).bold(),
    ]];
    let expected = "┌───────┐\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1m[[[[[\u{1b}[0m │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_s5() {
    let config = AsciiTable::default();
    let input = vec![vec![
        ";;;;;".color(Color::Blue).bg_color(Color::Yellow).bold(),
    ]];
    let expected = "┌───────┐\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1m;;;;;\u{1b}[0m │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_n5() {
    let config = AsciiTable::default();
    let input = vec![vec![
        "00000".color(Color::Blue).bg_color(Color::Yellow).bold(),
    ]];
    let expected = "┌───────┐\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1m00000\u{1b}[0m │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_missing_m() {
    let config = AsciiTable::default();
    let input = vec![vec!["\u{1b}[0Hello\u{1b}[0"]];

    let expected = "┌─────────────┐\n\
                    │ \u{1b}[0Hello\u{1b}[0 │\n\
                    └─────────────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes() {
    let config = AsciiTable::default();
    let input = vec![
        vec!["Hello".color(Color::Blue).bg_color(Color::Yellow).bold()],
        vec!["Hello".gradient(Color::Red)],
    ];
    let expected = "┌───────┐\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1mHello\u{1b}[0m │\n\
                    │ \u{1b}[38;2;255;0;0mH\u{1b}[38;2;255;6;0me\u{1b}[38;2;255;13;0ml\u{1b}[38;2;255;19;0ml\u{1b}[38;2;255;26;0mo\u{1b}[0m │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_in_header() {
    let mut config = AsciiTable::default();
    let text = "Hello".color(Color::Blue).bg_color(Color::Yellow).bold();
    config.column(0).set_header(text.to_string());

    let input = vec![&[""]];
    let expected = "┌───────┐\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1mHello\u{1b}[0m │\n\
                    ├───────┤\n\
                    │       │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_pad_right() {
    let config = AsciiTable::default();
    let input = vec![
        vec!["Hello".color(Color::Blue).bg_color(Color::Yellow).bold()],
        vec!["H".color(Color::Blue).bg_color(Color::Yellow).bold()],
    ];
    let expected = "┌───────┐\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1mHello\u{1b}[0m │\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1mH    \u{1b}[0m │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_pad_left() {
    let mut config = AsciiTable::default();
    config.column(0).set_align(Right);

    let input = vec![
        vec!["Hello".color(Color::Blue).bg_color(Color::Yellow).bold()],
        vec!["H".color(Color::Blue).bg_color(Color::Yellow).bold()],
    ];
    let expected = "┌───────┐\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1mHello\u{1b}[0m │\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1m    H\u{1b}[0m │\n\
                    └───────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "color_codes")]
#[test]
fn color_codes_trunc() {
    let mut config = AsciiTable::default();
    config.column(0).set_max_width(2);

    let input = vec![
        vec!["Hello".color(Color::Blue).bg_color(Color::Yellow).bold()],
        vec!["H".color(Color::Blue).bg_color(Color::Yellow).bold()],
    ];
    let expected = "┌────┐\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1mH+\u{1b}[0m │\n\
                    │ \u{1b}[38;5;4m\u{1b}[48;5;3;1mH \u{1b}[0m │\n\
                    └────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "wide_characters")]
#[test]
fn wide_characters() {
    let config = AsciiTable::default();
    let input = vec![vec!["👩"]];
    let expected = "┌────┐\n\
                    │ 👩 │\n\
                    └────┘\n";

    assert_eq!(expected, config.format(input));
}

#[cfg(feature = "wide_characters")]
#[test]
fn wide_characters2() {
    let config = AsciiTable::default();
    let input = vec![vec!["👩🔬"]];
    let expected = "┌──────┐\n\
                    │ 👩🔬 │\n\
                    └──────┘\n";

    assert_eq!(expected, config.format(input));
}
