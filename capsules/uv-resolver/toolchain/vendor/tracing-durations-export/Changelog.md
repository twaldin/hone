# Changelog

## 0.3.5

- Support dark mode in SVG export
- Use PEP 723 inline script metadata and a lockfile for `plot.py`

## 0.3.4

- Use unique IDs for exported spans

## 0.3.3

- Add options to skip rendering the top or bottom spans
- Fix panic if span wasn't closed

## 0.3.2

- Update dependencies

## 0.3.1

- Update dependencies

## 0.3.0

- Update svg to 0.17.0

## 0.2.0

- Show whether an active span is running on and blocking the main thread or whether it's running in a threadpool with
  `tokio::task::spawn_blocking`. `--color-top`/`color_top` gets split into two colors, color top main and color top
  threadpool. The former is used when the task is running on the main thread, the latter is used when it's offloaded to
  the threadpool.
- Colorblind friendly default colors (http://www.cookbook-r.com/Graphs/Colors_(ggplot2)/#a-colorblind-friendly-palette):
  - color top blocking: #E69F0088
  - color top threadpool: #56B4E988
  - color bottom: #E69F0088

## 0.1.2

- Add `--inline-field` / `inline_field` option: If the is only one field, display its value inline. Since the text is
  not limited to its box, text can overlap and become unreadable.
