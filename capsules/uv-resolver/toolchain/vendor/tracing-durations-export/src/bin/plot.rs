use anyhow::{Context, Result};
use clap::Parser;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::Duration;
use tracing_durations_export::plot::{plot, OwnedSpanInfo, PlotConfig, PlotLayout};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    input: PathBuf,
    #[clap(long)]
    output: Option<PathBuf>,
    /// Don't overlay bottom spans
    #[clap(long)]
    multi_lane: bool,
    /// Remove spans shorter than this, in seconds
    #[clap(long)]
    min_length: Option<f32>,
    /// If the is only one field, display its value inline.
    ///
    /// Since the text is not limited to its box, text can overlap and become unreadable.
    #[clap(long)]
    inline_field: bool,
    /// Remove spans with this name
    #[clap(long)]
    remove: Option<Vec<String>>,
    /// The color for the plots in the active region, when running on the main thread. Default: semi-transparent orange
    #[clap(long, default_value_t = PlotConfig::default().color_top_blocking)]
    color_top_blocking: String,
    /// The color for the plots in the active region, when the work offloaded from the main thread (with
    /// `tokio::task::spawn_blocking`. Default: semi-transparent green
    #[clap(long, default_value_t = PlotConfig::default().color_top_threadpool)]
    color_top_threadpool: String,
    /// The color for the plots in the total region. Default: semi-transparent blue
    #[clap(long, default_value_t = PlotConfig::default().color_bottom)]
    color_bottom: String,
    /// Do not draw the active regions.
    #[clap(long)]
    skip_top: bool,
    /// Do not draw the total durations regions.
    #[clap(long)]
    skip_bottom: bool,
}

fn main() -> Result<()> {
    let args: Args = Args::parse();

    // Read input
    let reader = BufReader::new(fs::File::open(&args.input)?);
    let spans: Vec<OwnedSpanInfo> = reader
        .lines()
        .map(|line| {
            let string = line.context("Failed to read line from input file")?;
            serde_json::from_str(&string).context("Invalid line in input file")
        })
        .collect::<Result<_>>()?;

    let end = spans
        .iter()
        .map(|span| span.end)
        .max()
        .context("Input file is empty")?;

    let plot_config = PlotConfig {
        multi_lane: args.multi_lane,
        min_length: args.min_length.map(Duration::from_secs_f32),
        remove: args.remove.map(|remove| remove.into_iter().collect()),
        inline_field: args.inline_field,
        color_top_blocking: args.color_top_blocking,
        color_top_threadpool: args.color_top_threadpool,
        color_bottom: args.color_bottom,
        skip_top: args.skip_top,
        skip_bottom: args.skip_bottom,
    };

    let document = plot(&spans, end, &plot_config, &PlotLayout::default());

    let svg = args.output.unwrap_or(args.input.with_extension("svg"));
    svg::save(svg, &document).context("Failed to write svg")?;
    Ok(())
}
