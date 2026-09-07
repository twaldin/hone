# syntax=docker/dockerfile:1
FROM rust@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663

# python3+time: trusted evaluator; nodejs: optimizer/proxy relay (node -e);
# bun: the sealed mutation-worker runtime. node+bun are the optimizer topology
# runtime the frozen capsule image must host so the development-train optimizer
# (and seed-optimizer pilots) can drive this capsule; they are never used by
# the trusted evaluator, which runs python3 eval.py.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 time nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown
COPY --from=mutation /usr/local/bin/bun /usr/local/bin/bun
# Pi coding-agent native addon (@oh-my-pi/pi-natives 16.5.2, matching the
# optimizer's pinned @oh-my-pi/pi-coding-agent) baked next to bun where the
# SDK loader's exec-dir candidate resolves it; a .node binary cannot ride
# inside the digest-sealed JS worker bundle.
COPY --from=mutation /usr/local/bin/pi_natives.linux-arm64.node /usr/local/bin/pi_natives.linux-arm64.node
RUN node --version && bun --version && test -f /usr/local/bin/pi_natives.linux-arm64.node

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
    && printf 'html{color:red}\n.smoke-100 .part-200 { margin: 1px }\nhtml { color:\n' > /tmp/hone-smoke.css \
    && /opt/target-seed/release/hone_biome_bench verify /tmp/hone-smoke.css /tmp/hs-o /tmp/hs-s /tmp/hs-d \
    && cmp /tmp/hs-o /tmp/hs-s \
    && /opt/target-seed/release/hone_biome_bench parse /tmp/hone-smoke.css 3 7 \
    && /opt/target-seed/release/hone_biome_bench format /tmp/hone-smoke.css 3 7 \
    && rm -f /tmp/hone-smoke.css /tmp/hs-o /tmp/hs-s /tmp/hs-d \
    && rm -f /opt/target-seed/release/.cargo*lock \
    && test ! -e /opt/biome/.git \
    && chmod -R a+rX /opt/biome /opt/vendor /opt/target-seed

WORKDIR /work
CMD ["bash"]
