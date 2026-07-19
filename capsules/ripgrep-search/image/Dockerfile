FROM rust@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc

LABEL org.opencontainers.image.title="hone-ripgrep-search" \
      org.opencontainers.image.source="https://github.com/BurntSushi/ripgrep" \
      org.opencontainers.image.revision="227381db0ee83dfa4341f1e27ff9617c0f5ad992"

RUN groupadd --gid 2000 sandbox \
    && useradd --uid 2000 --gid 2000 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
