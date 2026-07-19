# v4.0.8 (2025-10-12)

- Replaced the crate `termsize` with `termize` to fix a edge-case where it was unable to get the terminal
  width on some SSH sessions. This will only affect the `auto_table_width` feature.

# v4.0.7 (2025-05-14)

- Replaced the crate `lazy_static` with `std::sync::LazyLock`. This change is only for the `color_codes`
  feature.

# v4.0.6 (2025-02-25)

- Bumped Rust edition to 2024.
- Replaced `termion` with the more lightweight `termsize`. This will only affect the `auto_table_width`
  feature.

# v4.0.5 (2024-11-20)

- Bumped crate unicode-width from 0.1 to 0.2.

# v4.0.4 (2024-08-28)

- Bumped versions on 3rd party crates.

# v4.0.3 (2023-08-28)

- Added documentation to explain Ascii Table's features.
- Some minor refactoring.

# v4.0.2 (2022-01-25)

- Created a new feature `auto_table_width`. It will set the default max width of your ascii table to
  the width of your terminal. Note that `AsciiTable::set_max_width` will override this value.
- Changed ascii table default max width from 80 to 100.

# v4.0.1 (2022-01-24)

- Moved color code parsing to its own feature `color_codes`. Enable this feature when you want to display
  colors in the terminal using the `colorful` crate.
- Created a new feature `wide_characters` who will use unicode rules to determine the width of strings.
  Use this feature when you want to display emoji's or other wide characters.

# v4.0.0 (2022-01-23)

- Revamped API.
