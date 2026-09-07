# ascii-table

Print ASCII tables to the terminal.

## Example

```
use ascii_table::AsciiTable;

let ascii_table = AsciiTable::default();
let data = vec![&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]];
ascii_table.print(data);
// ┌───┬───┬───┐
// │ 1 │ 2 │ 3 │
// │ 4 │ 5 │ 6 │
// │ 7 │ 8 │ 9 │
// └───┴───┴───┘
```

## Example

```
use std::fmt::Display;
use ascii_table::{AsciiTable, Align};

let mut ascii_table = AsciiTable::default();
ascii_table.set_max_width(26);
ascii_table.column(0).set_header("H1").set_align(Align::Left);
ascii_table.column(1).set_header("H2").set_align(Align::Center);
ascii_table.column(2).set_header("H3").set_align(Align::Right);

let data: Vec<Vec<&dyn Display>> = vec![
    vec![&'v', &'v', &'v'],
    vec![&123, &456, &789, &"abcdef"]
];
ascii_table.print(data);
// ┌─────┬─────┬─────┬──────┐
// │ H1  │ H2  │ H3  │      │
// ├─────┼─────┼─────┼──────┤
// │ v   │  v  │   v │      │
// │ 123 │ 456 │ 789 │ abc+ │
// └─────┴─────┴─────┴──────┘
```

## Features

- `auto_table_width`: Sets the default max width of the ascii table to the width of the terminal.
- `color_codes`: Correctly calculates the width of a string when terminal color codes are present
  (like those from the `colorful` crate).
- `wide_characters`: Correctly calculates the width of a string when wide characters are present
  (like emoji's).
