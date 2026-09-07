//! Record and visualize which spans are active in parallel.
//!
//! ## Usage
//!
//! ```rust
//! use std::fs::File;
//! use std::io::BufWriter;
//! use tracing_durations_export::{DurationsLayer, DurationsLayerBuilder, DurationsLayerDropGuard};
//! use tracing_subscriber::layer::SubscriberExt;
//! use tracing_subscriber::{registry::Registry, fmt};
//!
//! fn setup_global_subscriber() -> DurationsLayerDropGuard {
//!     let fmt_layer = fmt::Layer::default();
//!     let (duration_layer, guard) = DurationsLayerBuilder::default()
//!         .durations_file("traces.ndjson")
//!         // Available with the `plot` feature
//!         // .plot_file("traces.svg")
//!         .build()
//!         .unwrap();
//!     let subscriber = Registry::default()
//!         .with(fmt_layer)
//!         .with(duration_layer);
//!
//!     tracing::subscriber::set_global_default(subscriber).unwrap();
//!
//!     guard
//! }
//!
//! // your code here ...
//! ```
//!
//! The output file will look something like below, where each section where a span is active is one line.
//!
//! ```ndjson
//! [...]
//! {"id":6,"name":"read_cache","start":{"secs":0,"nanos":122457871},"end":{"secs":0,"nanos":122463135},"parents":[5],"fields":{"id":"2"}}
//! {"id":5,"name":"cached_network_request","start":{"secs":0,"nanos":122433854},"end":{"secs":0,"nanos":122499689},"parents":[],"fields":{"id":"2","api":"https://example.net/cached"}}
//! {"id":9007474132647937,"name":"parse_cache","start":{"secs":0,"nanos":122625724},"end":{"secs":0,"nanos":125791908},"parents":[],"fields":{}}
//! {"id":5,"name":"cached_network_request","start":{"secs":0,"nanos":125973025},"end":{"secs":0,"nanos":126007737},"parents":[],"fields":{"id":"2","api":"https://example.net/cached"}}
//! {"id":5,"name":"cached_network_request","start":{"secs":0,"nanos":126061739},"end":{"secs":0,"nanos":126066912},"parents":[],"fields":{"id":"2","api":"https://example.net/cached"}}
//! {"id":2251799813685254,"name":"read_cache","start":{"secs":0,"nanos":126157156},"end":{"secs":0,"nanos":126193547},"parents":[2251799813685253],"fields":{"id":"3"}}
//! {"id":2251799813685253,"name":"cached_network_request","start":{"secs":0,"nanos":126144140},"end":{"secs":0,"nanos":126213181},"parents":[],"fields":{"api":"https://example.net/cached","id":"3"}}
//! {"id":27021597764222977,"name":"make_network_request","start":{"secs":0,"nanos":128343009},"end":{"secs":0,"nanos":128383121},"parents":[13510798882111491],"fields":{"api":"https://example.net/cached","id":"0"}}```
//! [...]
//! ```
//!
//! Note that 0 is the time of the first span, not the start of the process.

use fs::File;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fmt::Debug;
use std::io::{BufWriter, Write};
use std::marker::PhantomData;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{io, iter};
use tracing::field::Field;
use tracing::{span, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

#[cfg(feature = "plot")]
pub mod plot;

/// A zero timestamp initialized by the first span
static START: Lazy<Instant> = Lazy::new(Instant::now);

/// A recorded active section of a span.
#[derive(Serialize)]
// Remove bound on `RandomState`
#[serde(bound(serialize = ""))]
pub struct SpanInfo<'a, RS = RandomState> {
    pub id: u64,
    pub name: &'static str,
    pub start: Duration,
    pub end: Duration,
    pub parents: Option<&'a [u64]>,
    pub is_main_thread: bool,
    pub fields: Option<&'a HashMap<&'static str, String, RS>>,
}

pub struct DurationsLayerBuilder {
    /// See [`DurationsLayerBuilder::with_fields`].
    with_fields: bool,
    /// See [`DurationsLayerBuilder::with_parents`].
    with_parents: bool,
    /// See [`DurationsLayerBuilder::durations_file`].
    durations_file: Option<PathBuf>,
    /// See [`DurationsLayerBuilder::plot_file`].
    #[cfg(feature = "plot")]
    plot_file: Option<PathBuf>,
    #[cfg(feature = "plot")]
    plot_config: plot::PlotConfig,
    #[cfg(feature = "plot")]
    plot_layout: plot::PlotLayout,
}

impl Default for DurationsLayerBuilder {
    fn default() -> Self {
        Self {
            with_fields: true,
            with_parents: true,
            durations_file: None,
            #[cfg(feature = "plot")]
            plot_file: None,
            #[cfg(feature = "plot")]
            plot_config: plot::PlotConfig::default(),
            #[cfg(feature = "plot")]
            plot_layout: plot::PlotLayout::default(),
        }
    }
}

impl DurationsLayerBuilder {
    /// This function needs to be called on the (tokio) main thread for accurate reporting.
    pub fn build<S>(self) -> io::Result<(DurationsLayer<S>, DurationsLayerDropGuard)> {
        let out = self
            .durations_file
            .map(|file| File::create(file).map(BufWriter::new))
            .transpose()?;
        let layer = DurationsLayer {
            main_thead_id: std::thread::current().id(),
            start_index: Mutex::default(),
            fields: Mutex::default(),
            is_main_thread: Mutex::new(Default::default()),
            export_ids: Mutex::default(),
            next_export_id: AtomicU64::new(1),
            out: Arc::new(Mutex::new(out)),
            #[cfg(feature = "plot")]
            plot_data: Arc::new(Mutex::default()),
            #[cfg(feature = "plot")]
            plot_file: self.plot_file,
            with_fields: self.with_fields,
            with_parents: self.with_parents,
            #[cfg(feature = "plot")]
            plot_config: self.plot_config,
            #[cfg(feature = "plot")]
            plot_layout: self.plot_layout,
            _inner: PhantomData,
        };
        let guard = layer.drop_guard();
        Ok((layer, guard))
    }

    /// Whether to record the fields passed to the span (default: `true`).
    ///
    /// # Example
    ///
    /// Span:
    /// ```rust
    /// # use tracing::info_span;
    /// info_span!("make_request", host = "example.org", object = 10);
    /// ```
    ///
    /// With `true`:
    /// ```json
    /// {"id":4,"start":{"secs":0,"nanos":446},"end":{"secs":0,"nanos":448},"name":"make_request","parents":[1,3],"fields":{"host":"example.org","object":"10"}}
    /// ```
    ///
    /// With `false`:
    /// ```json
    /// {"id":4,"start":{"secs":0,"nanos":446},"end":{"secs":0,"nanos":448},"name":"make_request","parents":[1,3]}
    /// ```
    pub fn with_fields(self, enabled: bool) -> Self {
        Self {
            with_fields: enabled,
            ..self
        }
    }

    /// Whether to record the ids of the parent spans (default: `true`).
    ///
    /// # Example
    ///
    /// Span:
    /// ```rust
    /// # use tracing::info_span;
    /// info_span!("make_request", host = "example.org", object = 10);
    /// ```
    ///
    /// With `true`:
    /// ```json
    /// {"id":4,"start":{"secs":0,"nanos":446},"end":{"secs":0,"nanos":448},"name":"make_request","parents":[1,3],"fields":{"host":"example.org","object":"10"}}
    /// ```
    ///
    /// With `false`:
    /// ```json
    /// {"id":4,"start":{"secs":0,"nanos":446},"end":{"secs":0,"nanos":448},"name":"make_request","fields":{"host":"example.org","object":"10"}}
    /// ```
    pub fn with_parents(self, enabled: bool) -> Self {
        Self {
            with_parents: enabled,
            ..self
        }
    }

    /// Record all span active durations as ndjson.
    ///
    /// Example output line, see [module level documentation](`crate`) for more details.
    ///
    /// ```ndjson
    /// {"id":6,"name":"read_cache","start":{"secs":0,"nanos":122457871},"end":{"secs":0,"nanos":122463135},"parents":[3,4],"fields":{"id":"2"}}
    /// ```
    ///
    /// The file is flushed when [`DurationsLayerDropGuard`] is dropped.
    pub fn durations_file(self, file: impl Into<PathBuf>) -> Self {
        Self {
            durations_file: Some(file.into()),
            ..self
        }
    }

    /// Plot the result and save them as svg.
    ///
    /// TODO(konstin): Figure out how to embed an svg in rustdoc.
    ///
    /// The file is written when [`DurationsLayerDropGuard`] is dropped.
    #[cfg(feature = "plot")]
    pub fn plot_file(self, file: impl Into<PathBuf>) -> Self {
        Self {
            plot_file: Some(file.into()),
            ..self
        }
    }

    #[cfg(feature = "plot")]
    pub fn plot_config(self, plot_config: plot::PlotConfig) -> Self {
        Self {
            plot_config,
            ..self
        }
    }
}

type CollectedFields<RS> = HashMap<&'static str, String, RS>;

#[derive(Default)]
struct FieldsCollector<RS = RandomState>(CollectedFields<RS>);

impl tracing::field::Visit for FieldsCollector {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name(), value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        self.0.insert(field.name(), format!("{value:?}"));
    }
}

/// On drop, flush the output writer and, if applicable, write the plot.
pub struct DurationsLayerDropGuard {
    out: Arc<Mutex<Option<BufWriter<File>>>>,
    #[cfg(feature = "plot")]
    plot_file: Option<PathBuf>,
    #[cfg(feature = "plot")]
    plot_data: Arc<Mutex<Vec<plot::OwnedSpanInfo>>>,
    #[cfg(feature = "plot")]
    plot_config: plot::PlotConfig,
    #[cfg(feature = "plot")]
    plot_layout: plot::PlotLayout,
}

impl Drop for DurationsLayerDropGuard {
    fn drop(&mut self) {
        if let Some(out) = self.out.lock().expect("There was a prior panic").as_mut() {
            if let Err(err) = out.flush() {
                eprintln!("`DurationLayer` failed to flush out file: {err}");
            }
        }

        #[cfg(feature = "plot")]
        {
            if let Some(plot_file) = &self.plot_file {
                let end = self
                    .plot_data
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|span| span.end)
                    .max();
                // This is some only if the plot option was and any spans were recorded
                if let Some(end) = end {
                    let svg = plot::plot(
                        &self.plot_data.lock().expect("There was a prior panic"),
                        end,
                        &self.plot_config,
                        &self.plot_layout,
                    );
                    if let Err(err) = svg::save(plot_file, &svg) {
                        eprintln!("`DurationLayer` failed to write plot: {err}");
                    }
                }
            }
        }
    }
}

/// `tracing` layer to record which spans are active in parallel as ndjson.
pub struct DurationsLayer<S, RS = RandomState> {
    main_thead_id: std::thread::ThreadId,
    // Each of the 3 fields below has different initialization:
    //
    // TODO(konstin): Attach this as span extension instead?
    start_index: Mutex<HashMap<span::Id, Duration, RS>>,
    // TODO(konstin): Attach this as span extension instead?
    fields: Mutex<HashMap<span::Id, CollectedFields<RS>>>,
    // TODO(konstin): Attach this as span extension instead?
    is_main_thread: Mutex<HashMap<span::Id, bool>>,
    // TODO(konstin): Attach this as span extension instead?
    /// <https://github.com/tokio-rs/tracing/blob/f40ccdaa03cf114c7ee1ef14949207626bf6be57/tracing-subscriber/src/registry/sharded.rs#L41-L77>
    export_ids: Mutex<HashMap<span::Id, u64, RS>>,
    /// <https://github.com/tokio-rs/tracing/blob/f40ccdaa03cf114c7ee1ef14949207626bf6be57/tracing-subscriber/src/registry/sharded.rs#L41-L77>
    next_export_id: AtomicU64,
    out: Arc<Mutex<Option<BufWriter<File>>>>,
    #[cfg(feature = "plot")]
    plot_data: Arc<Mutex<Vec<plot::OwnedSpanInfo>>>,
    #[cfg(feature = "plot")]
    plot_file: Option<PathBuf>,
    with_fields: bool,
    with_parents: bool,
    #[cfg(feature = "plot")]
    plot_config: plot::PlotConfig,
    #[cfg(feature = "plot")]
    plot_layout: plot::PlotLayout,
    _inner: PhantomData<S>,
}

impl<S> DurationsLayer<S> {
    fn drop_guard(&self) -> DurationsLayerDropGuard {
        DurationsLayerDropGuard {
            out: self.out.clone(),
            #[cfg(feature = "plot")]
            plot_file: self.plot_file.clone(),
            #[cfg(feature = "plot")]
            plot_data: self.plot_data.clone(),
            #[cfg(feature = "plot")]
            plot_config: self.plot_config.clone(),
            #[cfg(feature = "plot")]
            plot_layout: self.plot_layout.clone(),
        }
    }
}

impl<S> Layer<S> for DurationsLayer<S>
where
    S: Subscriber + for<'span> LookupSpan<'span>,
{
    /// Record the fields
    fn on_new_span(&self, attrs: &span::Attributes<'_>, id: &span::Id, _ctx: Context<'_, S>) {
        self.export_ids
            .lock()
            .expect("There was a prior panic")
            .insert(
                id.clone(),
                self.next_export_id.fetch_add(1, Ordering::Relaxed),
            );

        // We only get the fields here (i think they aren't stored with the span?), so we have to record them here
        if self.with_fields {
            let mut visitor = FieldsCollector::default();
            attrs.record(&mut visitor);
            self.fields
                .lock()
                .expect("There was a prior panic")
                .insert(id.clone(), visitor.0);
        }
        self.is_main_thread
            .lock()
            .expect("There was a prior panic")
            .insert(
                id.clone(),
                self.main_thead_id == std::thread::current().id(),
            );
    }

    /// Record the start timestamp
    fn on_enter(&self, id: &span::Id, _ctx: Context<'_, S>) {
        self.start_index
            .lock()
            .unwrap()
            .insert(id.clone(), START.elapsed());
    }

    /// Write a record to the ndjson writer
    fn on_exit(&self, id: &span::Id, ctx: Context<'_, S>) {
        let span = ctx.span(id).unwrap();
        let export_ids = self.export_ids.lock().expect("There was a prior panic");
        let export_id = export_ids.get(id).copied().unwrap_or_else(|| id.into_u64());
        let parents = if self.with_parents {
            let parents = iter::successors(span.parent(), |span| span.parent())
                .map(|span| {
                    let id = span.id();
                    export_ids
                        .get(&id)
                        .copied()
                        .unwrap_or_else(|| id.into_u64())
                })
                .collect::<Vec<_>>();
            Some(parents)
        } else {
            None
        };
        drop(export_ids);
        let attributes = self.fields.lock().expect("There was a prior panic");
        let fields = attributes.get(id);
        debug_assert!(
            !self.with_fields || fields.is_some(),
            "Expected fields to be record for span {} {}",
            span.name(),
            id.into_u64()
        );

        let is_main_thread = self.main_thead_id == std::thread::current().id();
        let span_info = SpanInfo {
            id: export_id,
            name: span.name(),
            start: self.start_index.lock().expect("There was a prior panic")[id],
            end: START.elapsed(),
            parents: parents.as_deref(),
            is_main_thread,
            fields,
        };
        // https://github.com/rust-lang/rust-clippy/pull/12892
        #[allow(clippy::needless_borrows_for_generic_args)]
        if let Some(mut writer) = self.out.lock().expect("There was a prior panic").as_mut() {
            // ndjson, write the json and then a newline
            serde_json::to_writer(&mut writer, &span_info).unwrap();
            writeln!(&mut writer).unwrap();
        }

        #[cfg(feature = "plot")]
        {
            if self.plot_file.is_some() {
                self.plot_data
                    .lock()
                    .expect("There was a prior panic")
                    .push(plot::OwnedSpanInfo {
                        id: export_id,
                        name: span.name().to_string(),
                        start: self.start_index.lock().expect("There was a prior panic")[id],
                        end: START.elapsed(),
                        parents,
                        is_main_thread,
                        fields: fields.map(|fields| {
                            fields
                                .iter()
                                .map(|(key, value)| (key.to_string(), value.to_string()))
                                .collect()
                        }),
                    })
            }
        }
    }

    fn on_close(&self, id: span::Id, _ctx: Context<'_, S>) {
        self.start_index
            .lock()
            .expect("There was a prior panic")
            .remove(&id);
        self.fields
            .lock()
            .expect("There was a prior panic")
            .remove(&id);
        self.is_main_thread
            .lock()
            .expect("There was a prior panic")
            .remove(&id);
        self.export_ids
            .lock()
            .expect("There was a prior panic")
            .remove(&id);
    }
}
