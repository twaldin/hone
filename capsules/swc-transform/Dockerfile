FROM rust:1.97-bookworm@sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa

LABEL org.opencontainers.image.source="https://github.com/swc-project/swc" \
      org.opencontainers.image.revision="d5fd89520be380493479d232b88c532e94e1df94" \
      org.opencontainers.image.licenses="Apache-2.0" \
      hone.capsule="swc-transform"

RUN rustup toolchain install nightly-2026-04-10 --profile minimal \
    && apt-get update \
    && apt-get install -y --no-install-recommends clang lld python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 2000 sandbox \
    && useradd --uid 2000 --gid 2000 --no-create-home --shell /usr/sbin/nologin sandbox

ENV RUSTUP_TOOLCHAIN=nightly-2026-04-10 \
    CARGO_HOME=/usr/local/cargo \
    CARGO_NET_OFFLINE=true \
    CARGO_INCREMENTAL=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0

COPY image/vendor/ /opt/swc-vendor/
COPY --chown=2000:2000 image/source/ /opt/swc-root/

USER sandbox
WORKDIR /opt/swc-root
RUN cargo build --locked --offline --jobs 2 --profile hone -p hone-swc-bench \
    && cargo test --locked --offline --jobs 2 --profile hone -p swc_ecma_parser --lib \
    && cargo test --locked --offline --jobs 2 --profile hone -p swc_ecma_transforms_base --lib \
    && cargo test --locked --offline --jobs 2 --profile hone -p swc_ecma_transforms_typescript --lib \
    && cargo test --locked --offline --jobs 2 --profile hone -p swc_ecma_transforms_react --lib \
    && target/hone/hone-swc-bench selftest

USER root
COPY image/finalize_image.py /tmp/finalize_image.py
RUN python3 /tmp/finalize_image.py \
    && rm /tmp/finalize_image.py

WORKDIR /
