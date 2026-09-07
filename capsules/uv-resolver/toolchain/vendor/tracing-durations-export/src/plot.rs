//! Visualize the spans and save the plot as svg.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use itertools::Itertools;
use rustc_hash::FxHashMap;
use serde::Deserialize;
use svg::node::element::{Rectangle, Style, Text, Title, SVG};
use svg::Document;

const PLOT_STYLE: &str = r#"
:root {
  color-scheme: light dark;
  --plot-background: #ffffff;
  --plot-foreground: #111827;
}

@media (prefers-color-scheme: dark) {
  :root {
    --plot-background: #111827;
    --plot-foreground: #e5e7eb;
  }
}

.plot-background {
  fill: var(--plot-background);
}

text {
  fill: var(--plot-foreground);
}
"#;

/// Owned type for deserialization.
#[derive(Deserialize, Clone)]
pub struct OwnedSpanInfo {
    pub id: u64,
    pub name: String,
    pub start: Duration,
    pub end: Duration,
    #[allow(dead_code)]
    pub parents: Option<Vec<u64>>,
    pub is_main_thread: bool,
    pub fields: Option<HashMap<String, String>>,
}

impl OwnedSpanInfo {
    fn secs(&self) -> f32 {
        (self.end - self.start).as_secs_f32()
    }
}

/// Common visualization options.
#[derive(Debug, Clone)]
pub struct PlotConfig {
    /// Don't overlay bottom spans.
    pub multi_lane: bool,
    /// Remove spans shorter than this.
    pub min_length: Option<Duration>,
    /// Remove spans with this name.
    pub remove: Option<HashSet<String>>,
    /// If the is only one field, display its value inline.
    ///
    /// Since the text is not limited to its box, text can overlap and become unreadable.
    pub inline_field: bool,
    /// The color for the plots in the active region, when running on the main thread. Default: semi-transparent orange
    pub color_top_blocking: String,
    /// The color for the plots in the active region, when the work offloaded from the main thread (with
    /// `tokio::task::spawn_blocking`. Default: semi-transparent green
    pub color_top_threadpool: String,
    /// The color for the plots in the total region. Default: semi-transparent blue
    pub color_bottom: String,
    /// Do not draw the active regions.
    pub skip_top: bool,
    /// Do not draw the total durations regions.
    pub skip_bottom: bool,
}

impl Default for PlotConfig {
    fn default() -> Self {
        PlotConfig {
            multi_lane: false,
            min_length: None,
            remove: None,
            inline_field: false,
            // See http://www.cookbook-r.com/Graphs/Colors_(ggplot2)/#a-colorblind-friendly-palette
            color_top_blocking: "#E69F0088".to_string(),
            color_top_threadpool: "#009E7388".to_string(),
            color_bottom: "#56B4E988".to_string(),
            skip_top: false,
            skip_bottom: false,
        }
    }
}

/// The dimensions of each part of the plot.
#[derive(Debug, Clone)]
pub struct PlotLayout {
    /// Padding top for the entire svg.
    pub padding_top: usize,
    /// Padding bottom for the entire svg.
    pub padding_bottom: usize,
    /// Padding left for the entire svg.
    pub padding_left: usize,
    /// Padding right for the entire svg.
    pub padding_right: usize,
    /// The width of the text column on the left.
    pub text_col_width: usize,
    /// The of the bar plot section on the entire middle-right.
    pub content_col_width: usize,
    /// The height of each of the bars.
    pub bar_height: usize,
    /// In expanded mode, this much space is between the tracks.
    pub multi_lane_padding: usize,
    /// The padding between different kinds of spans.
    pub section_padding_height: usize,
}

impl Default for PlotLayout {
    fn default() -> Self {
        PlotLayout {
            padding_top: 5,
            padding_bottom: 5,
            padding_left: 5,
            padding_right: 5,
            text_col_width: 250,
            content_col_width: 850,
            bar_height: 20,
            multi_lane_padding: 1,
            section_padding_height: 10,
        }
    }
}

/// Visualize the spans.
///
/// You can store the result with `svg::save(plot_file, &svg)`.
pub fn plot(
    spans: &[OwnedSpanInfo],
    end: Duration,
    config: &PlotConfig,
    layout: &PlotLayout,
) -> SVG {
    // TODO(konstin): Cow or move out of this method?
    let spans = if let Some(remove) = &config.remove {
        spans
            .iter()
            .filter(|span| !remove.contains(&span.name))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        spans.to_vec()
    };

    // Spans can enter and exit multiple times, so we need to collect the duration from first start
    // to last end to get the full span duration.
    let mut full_spans: FxHashMap<u64, OwnedSpanInfo> = FxHashMap::default();
    for span in &spans {
        // These are in order because a span is emitted when it exits and exit must happen before
        // re-entry
        full_spans.entry(span.id).or_insert(span.clone()).end = span.end;
    }

    // Remove too short spans
    // TODO(konstin): Again, copy on write?
    let (spans, full_spans) = if let Some(min_length) = config.min_length {
        let mut removed_ids = HashSet::new();
        for (id, full_span) in &full_spans {
            if full_span.end - full_span.start < min_length {
                removed_ids.insert(*id);
            }
        }
        let spans = spans
            .iter()
            .filter(|span| !removed_ids.contains(&span.id))
            .cloned()
            .collect::<Vec<_>>();
        for removed_id in removed_ids {
            full_spans.remove(&removed_id);
        }
        (spans, full_spans)
    } else {
        (spans.to_vec(), full_spans)
    };

    let mut earliest_starts: FxHashMap<&str, Duration> = FxHashMap::default();
    for span in &spans {
        // For the left sidebar, sort spans by the first time a span name occurred
        match earliest_starts.entry(&span.name) {
            Entry::Occupied(mut entry) => {
                if entry.get() > &span.start {
                    entry.insert(span.start);
                }
            }
            Entry::Vacant(entry) => {
                entry.insert(span.start);
            }
        }
    }

    // In expanded mode, we avoid overlaps in different lanes, so we track
    // until which timestamp each lane is blocked and how many lanes we need.
    let mut lanes_end: HashMap<&str, Vec<Duration>> = HashMap::new();
    let mut span_lanes = HashMap::new();
    let mut full_spans_sorted: Vec<_> = full_spans.values().collect();
    full_spans_sorted.sort_by_key(|span| span.start);
    for full_span in full_spans_sorted {
        if config.multi_lane {
            let lanes = lanes_end.entry(&full_span.name).or_default();
            if let Some((idx, lane_end)) = lanes
                .iter_mut()
                .enumerate()
                .find(|(_idx, end)| &full_span.start > end)
            {
                span_lanes.insert(full_span.id, idx);
                *lane_end = full_span.end;
            } else {
                span_lanes.insert(full_span.id, lanes.len());
                lanes.push(full_span.end)
            }
        } else {
            span_lanes.insert(full_span.id, 0);
            lanes_end
                .entry(&full_span.name)
                .or_insert_with(|| vec![full_span.end])[0] = full_span.end;
        }
    }

    let extra_lane_height = layout.bar_height / 2 + layout.multi_lane_padding;

    let mut earliest_starts: Vec<_> = earliest_starts.into_iter().collect();
    earliest_starts.sort_by_key(|(_name, duration)| *duration);
    let name_offsets: FxHashMap<&str, usize> = earliest_starts
        .iter()
        .enumerate()
        // Add an empty line for the timeline
        .map(|(idx, (name, _earliest_start))| (*name, idx + 1))
        .collect();

    // TODO(konstin): Functional version?
    let mut extra_lanes_cur = 0;
    let mut extra_lanes_cumulative = HashMap::new();
    for (name, _start) in earliest_starts {
        extra_lanes_cumulative.insert(name, extra_lanes_cur);
        extra_lanes_cur += lanes_end.get(name).map_or(0, |lanes| lanes.len() - 1);
    }

    let total_width = layout.padding_left
        + layout.text_col_width
        + layout.content_col_width
        + layout.padding_right;
    // Don't forget the timeline row
    let total_height = layout.padding_top
        + (layout.bar_height + layout.section_padding_height) * (name_offsets.len() + 1)
        + extra_lane_height * extra_lanes_cur
        + layout.padding_bottom;

    let mut document = Document::new()
        .set("width", total_width)
        .set("height", total_height)
        .set("viewBox", (0, 0, total_width, total_height))
        .add(Style::new(PLOT_STYLE))
        .add(
            Rectangle::new()
                .set("class", "plot-background")
                .set("x", 0)
                .set("y", 0)
                .set("width", total_width)
                .set("height", total_height)
                .set("fill", "#ffffff"),
        );

    // Add the "timeline" of start and stop time.
    document = document
        .add(
            Text::new("0s")
                .set("x", layout.text_col_width)
                .set("y", layout.padding_top + layout.bar_height / 2)
                .set("dominant-baseline", "middle")
                .set("text-anchor", "start"),
        )
        .add(
            Text::new(format!("{:.3}s", end.as_secs_f32()))
                .set("x", layout.text_col_width + layout.content_col_width)
                .set("y", layout.padding_top + layout.bar_height / 2)
                .set("dominant-baseline", "middle")
                .set("text-anchor", "end"),
        );

    // Add a note about filtered out spans
    if let Some(min_length) = config.min_length {
        let text = format!("only spans >{}s", min_length.as_secs_f32());
        document = document.add(
            Text::new(text)
                .set("x", layout.padding_left)
                .set("y", layout.padding_top + layout.bar_height / 2)
                .set("dominant-baseline", "middle")
                .set("text-anchor", "start"),
        );
    }

    // Draw the legend on the left
    for (name, offset) in &name_offsets {
        document = document.add(
            Text::new(name.to_string())
                .set("x", layout.padding_left)
                .set(
                    "y",
                    layout.padding_top
                        + layout.bar_height / 2
                        + offset * (layout.bar_height + layout.section_padding_height)
                        + extra_lane_height * extra_lanes_cumulative[name],
                )
                .set("dominant-baseline", "middle"),
        );
    }

    let format_tooltip = |span: &OwnedSpanInfo| {
        let fields = span
            .fields
            .iter()
            .flatten()
            .map(|(key, value)| format!("{key}: {value}"))
            .join("\n");
        format!("{} {:.3}s\n{}", span.name, span.secs(), fields)
    };

    // Draw the active top half of each span
    if !config.skip_top {
        for span in &spans {
            let offset = name_offsets[span.name.as_str()];
            let color = if span.is_main_thread {
                config.color_top_blocking.clone()
            } else {
                config.color_top_threadpool.clone()
            };
            document = document.add(
                Rectangle::new()
                    .set(
                        "x",
                        layout.text_col_width as f32
                            + layout.content_col_width as f32 * span.start.as_secs_f32()
                                / end.as_secs_f32(),
                    )
                    .set(
                        "y",
                        offset * (layout.bar_height + layout.section_padding_height)
                            + extra_lane_height * extra_lanes_cumulative[span.name.as_str()],
                    )
                    .set(
                        "width",
                        layout.content_col_width as f32 * span.secs() / end.as_secs_f32(),
                    )
                    .set("height", layout.bar_height / 2)
                    .set("fill", color)
                    // Add tooltip
                    .add(Title::new(format_tooltip(span))),
            )
        }
    }

    // Draw the total bottom half of each span
    if !config.skip_bottom {
        for full_span in full_spans.values() {
            let x = layout.text_col_width as f32
                + layout.content_col_width as f32 * full_span.start.as_secs_f32()
                    / end.as_secs_f32();
            let y = name_offsets[full_span.name.as_str()]
                * (layout.bar_height + layout.section_padding_height)
                + extra_lane_height * extra_lanes_cumulative[full_span.name.as_str()]
                + extra_lane_height * span_lanes[&full_span.id]
                + layout.bar_height / 2;
            let width = layout.content_col_width as f32
                * (full_span.end - full_span.start).as_secs_f32()
                / end.as_secs_f32();
            let height = layout.bar_height / 2;
            document = document.add(
                Rectangle::new()
                    .set("x", x)
                    .set("y", y)
                    .set("width", width)
                    .set("height", height)
                    .set("fill", config.color_bottom.to_string())
                    // Add tooltip
                    .add(Title::new(format_tooltip(full_span))),
            );
            let mut fields = full_span
                .fields
                .as_ref()
                .map(|map| map.values())
                .into_iter()
                .flatten();
            if let Some(value) = fields.next() {
                if config.inline_field && fields.next().is_none() {
                    document = document.add(
                        Text::new(value)
                            .set("x", x)
                            .set("y", y + height / 2)
                            .set("font-size", "0.7em")
                            .set("dominant-baseline", "middle")
                            .set("text-anchor", "start"),
                    )
                }
            }
        }
    }

    document
}
