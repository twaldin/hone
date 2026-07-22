# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM python:3.12.11-bookworm@sha256:13c9584604a99ca134c4f41800f74ffc64ee6ac8cf555cf1e704a6087fc84f12 AS python
FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
LABEL org.opencontainers.image.source="https://github.com/ijl/orjson" \
      org.opencontainers.image.revision="705515d77b28429d0b7c30c3d781abe52e8a1e5a" \
      org.opencontainers.image.licenses="MPL-2.0 AND (Apache-2.0 OR MIT)" \
      hone.capsule="orjson-serialization"

COPY --from=python /usr/local/ /usr/local/
ENV PATH="/usr/local/bin:/usr/local/cargo/bin:${PATH}" \
    CARGO_HOME=/usr/local/cargo \
    CARGO_NET_OFFLINE=true \
    CARGO_INCREMENTAL=0 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0

COPY image/wheels/ /opt/orjson/wheels/
RUN python -m pip install --no-cache-dir --no-index --find-links=/opt/orjson/wheels \
      maturin==1.9.4 numpy==2.3.3 pytest==9.0.2 faker==37.8.0 \
      python-dateutil==2.9.0.post0 pytz==2025.2

COPY image/cargo/vendor/ /opt/orjson/vendor/
COPY image/cargo-config.toml /usr/local/cargo/config.toml
COPY image/prepare-target.py /opt/orjson/prepare-target.py
COPY baseline/ /opt/orjson/source/
RUN cd /opt/orjson/source \
    && CARGO_TARGET_DIR=/opt/orjson/target-template maturin build --release --offline --out /opt/orjson/wheelhouse \
    && python -m pip install --no-index /opt/orjson/wheelhouse/orjson-*.whl \
    && pytest -q test \
    && rm -rf /root/.cache /tmp/*

RUN useradd --uid 2000 --no-create-home --shell /usr/sbin/nologin sandbox

# nodejs: optimizer/proxy relay (node -e); bun + Pi native addon: the sealed
# mutation-worker runtime baked next to bun where the SDK loader's exec-dir
# candidate resolves it. Optimizer-topology runtime the frozen capsule image
# must host so the development-train optimizer (and seed-optimizer pilots)
# can drive this capsule; never used by the trusted evaluator (python3 eval.py).
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
COPY --from=mutation /usr/local/bin/bun /usr/local/bin/bun
COPY --from=mutation /usr/local/bin/pi_natives.linux-arm64.node /usr/local/bin/pi_natives.linux-arm64.node
RUN node --version && bun --version && test -f /usr/local/bin/pi_natives.linux-arm64.node
