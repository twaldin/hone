# syntax=docker/dockerfile:1
FROM rust@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 time \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown

COPY --from=vendor . /opt/vendor
COPY --from=config cargo-config.toml /usr/local/cargo/config.toml
COPY . /opt/biome
RUN rm -rf /opt/biome/.git /opt/biome/.hone-pin-ok /opt/biome/target
COPY --from=harness . /opt/biome/crates/hone_biome_bench

ENV CARGO_NET_OFFLINE=true \
    CARGO_INCREMENTAL=0 \
    CARGO_PROFILE_RELEASE_LTO=false \
    RUST_BACKTRACE=0
WORKDIR /opt/biome
RUN cargo generate-lockfile --offline \
    && CARGO_TARGET_DIR=/opt/target-seed cargo build --locked --offline --release -p hone_biome_bench \
    && /opt/target-seed/release/hone_biome_bench selftest \
    && rm -f /opt/target-seed/release/.cargo*lock \
    && test ! -e /opt/biome/.git \
    && chmod -R a+rX /opt/biome /opt/vendor /opt/target-seed

WORKDIR /work
CMD ["bash"]
