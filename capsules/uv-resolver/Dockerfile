FROM rust:1.97-bookworm@sha256:77fac8b98f9f46062bb680b6d25d5bcaabfc400143952ebc572e924bcbedc3fa

RUN rustup toolchain install 1.97.0 --profile minimal \
    && rustup default 1.97.0 \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 2000 sandbox \
    && useradd --uid 2000 --gid 2000 --no-create-home --shell /usr/sbin/nologin sandbox \
    && mkdir /opt/uv-root \
    && chown 2000:2000 /opt/uv-root \
    && ln -s /usr/local/rustup/toolchains/1.97.0-aarch64-unknown-linux-gnu/lib/rustlib/aarch64-unknown-linux-gnu/bin/rust-lld /usr/local/bin/ld.lld

ENV RUSTUP_TOOLCHAIN=1.97.0 \
    CARGO_PROFILE_PROFILING_DEBUG=0 \
    CARGO_PROFILE_PROFILING_STRIP=debuginfo \
    RUSTFLAGS="-C link-arg=-fuse-ld=lld" \
    CARGO_HOME=/opt/uv-root/target/cargo-home

COPY --chown=2000:2000 source/ /opt/uv-root/
COPY --chown=2000:2000 toolchain/vendor/ /opt/uv-root/vendor/

USER sandbox
WORKDIR /opt/uv-root
RUN cargo build --locked --offline --jobs 2 --profile profiling --bin uv --no-default-features \
    && cargo test --locked --offline --jobs 2 -p uv-resolver --profile profiling

USER root
WORKDIR /
COPY toolchain/finalize_image.py /tmp/finalize_image.py
RUN python3 /tmp/finalize_image.py \
    && rm /tmp/finalize_image.py
