use futures::StreamExt;
use rand::RngExt;
use std::env;
use std::time::Duration;
use tokio::task::spawn_blocking;
use tracing::instrument;
use tracing_durations_export::DurationsLayerBuilder;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

#[instrument]
async fn make_network_request(api: &str, id: usize) -> String {
    let millis = rand::rng().random_range(5..10);
    tokio::time::sleep(Duration::from_millis(millis)).await;
    format!("{api} {id}")
}

#[instrument]
async fn read_cache(id: usize) -> Option<String> {
    let millis = rand::rng().random_range(1..3);
    tokio::time::sleep(Duration::from_millis(millis)).await;
    // There's a 50% change there's a cache entry
    if rand::rng().random_bool(0.5) {
        Some(format!("cached({id})"))
    } else {
        None
    }
}

/// cpu intensive, blocking method
#[instrument(skip_all)]
fn parse_cache(data: &str) -> String {
    let millis = rand::rng().random_range(2..6);
    std::thread::sleep(Duration::from_millis(millis));
    format!("from_cache({data})")
}

/// cpu intensive, blocking method
#[instrument(skip_all)]
fn parse_network(data: &str) -> String {
    let millis = rand::rng().random_range(3..8);
    std::thread::sleep(Duration::from_millis(millis));
    format!("from_network({data})")
}

#[instrument]
async fn cached_network_request(api: &str, id: usize) -> String {
    if let Some(cached) = read_cache(id).await {
        spawn_blocking(move || parse_cache(&cached))
            .await
            .expect("executor died")
    } else {
        let response = make_network_request(api, id).await;
        spawn_blocking(move || parse_network(&response))
            .await
            .expect("executor died")
    }
}

#[tokio::main]
async fn main() {
    let (duration_layer, _guard) = if let Ok(location) = env::var("TRACING_DURATION_EXPORT") {
        let (layer, guard) = DurationsLayerBuilder::default()
            .durations_file(location)
            .build()
            .expect("Couldn't create TRACING_DURATION_FILE");
        (Some(layer), Some(guard))
    } else {
        (None, None)
    };
    tracing_subscriber::registry().with(duration_layer).init();

    // Sequential
    futures::stream::iter(0..4)
        .then(|id| make_network_request("https://example.org/uncached", id))
        .then(|data| async {
            spawn_blocking(move || parse_network(&data))
                .await
                .expect("the executor is broken")
        })
        .collect::<Vec<String>>()
        .await;

    // Spacer
    tokio::time::sleep(Duration::from_millis(5)).await;

    // Parallel
    futures::stream::iter(0..4)
        .map(|id| async move {
            let data = make_network_request("https://example.org/uncached", id).await;
            spawn_blocking(move || parse_network(&data))
                .await
                .expect("the executor is broken")
        })
        .buffer_unordered(4)
        .collect::<Vec<String>>()
        .await;

    tokio::time::sleep(Duration::from_millis(5)).await;

    // Sequential
    futures::stream::iter(0..4)
        .then(|id| cached_network_request("https://example.net/cached", id))
        .collect::<Vec<String>>()
        .await;

    tokio::time::sleep(Duration::from_millis(5)).await;

    // Parallel
    futures::stream::iter(0..4)
        .map(|id| cached_network_request("https://example.net/cached", id))
        .buffer_unordered(3)
        .collect::<Vec<String>>()
        .await;
}
