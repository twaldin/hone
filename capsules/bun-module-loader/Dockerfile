FROM ghcr.io/oven-sh/bun-development-docker-image@sha256:f627937ba0ed62821e75b7cbe2a9b8a73dd69234442c04ad49f7b327fb7f8300 AS build

ARG BUN_REVISION=5187e27669440a72ab1b082f92b7f1b5ca94cfc1
ENV GIT_SHA=${BUN_REVISION} \
    CC=clang-21 \
    CXX=clang++-21 \
    AR=llvm-ar-21 \
    RANLIB=llvm-ranlib-21 \
    LD=lld-21 \
    LLVM_VERSION=21.1.8 \
    CARGO_NET_OFFLINE=true \
    CARGO_PROFILE_RELEASE_LTO=off \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    RUSTUP_HOME=/opt/rust \
    BUN_NO_CORE_DUMP=1 \
    NO_COLOR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends time \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 2000 --user-group --no-create-home --shell /usr/sbin/nologin sandbox

RUN curl -fsSL "https://pub-5e11e972747a44bf9aaf9394f185a982.r2.dev/releases/bun-v1.3.13/bun-linux-aarch64.zip" -o /tmp/bun.zip \
    && unzip -q /tmp/bun.zip -d /tmp/bootstrap-bun \
    && install -m 0755 /tmp/bootstrap-bun/bun-linux-aarch64/bun /usr/local/bun/bin/bun \
    && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun \
    && test "$(bun --version)" = "1.3.13" \
    && echo '67892bb6734ef352f90a964f0a2a680d5f6e6d15bdb5510e56b8065ac4d599ae  /usr/local/bun/bin/bun' | sha256sum -c - \
    && rm -rf /tmp/bootstrap-bun /tmp/bun.zip

COPY .candidate-5187e276 /opt/bun
WORKDIR /opt/bun

RUN rm -rf .git .gitdir .hone-pin-ok \
    && printf '%s\n' "$BUN_REVISION" > /opt/bun/source-revision.txt \
    && bun install --frozen-lockfile \
    && mkdir -p /tmp/hone-resolver-test-deps \
    && printf '%s\n' '{"private":true,"dependencies":{"reflect-metadata":"0.2.2","tsyringe":"4.8.0"}}' > /tmp/hone-resolver-test-deps/package.json \
    && cd /tmp/hone-resolver-test-deps \
    && bun install --ignore-scripts \
    && mkdir -p /opt/bun/test/node_modules \
    && cp -a node_modules/. /opt/bun/test/node_modules/ \
    && cd /opt/bun \
    && rm -rf /tmp/hone-resolver-test-deps \
    && CARGO_NET_OFFLINE=false python3 -c 'import pathlib,subprocess,time; t=time.perf_counter(); subprocess.run(["bun","scripts/build.ts","--profile=release","-j2"], check=True); pathlib.Path("/opt/bun/clean-build-seconds.txt").write_text(f"{time.perf_counter()-t:.6f}\n")' \
    && CARGO_NET_OFFLINE=false cargo fetch --locked \
    && CARGO_NET_OFFLINE=true cargo fetch --locked \
    && test "$(build/release/bun-profile --revision | tail -n 1)" = "1.4.0-canary.1+5187e2766"

RUN build/release/bun-profile test ./test/js/bun/resolve/resolve.test.ts ./test/js/bun/resolve/resolve-ts.test.ts ./test/js/bun/resolve/import-meta-resolve.test.mjs \
    && CARGO_NET_OFFLINE=true bun scripts/build.ts --profile=release -j2 \
    && mkdir -p build/release/hone-cargo build/release/hone-home build/release/hone-bun-cache \
    && cp -a /root/.cargo/. build/release/hone-cargo/ \
    && chmod -R a+rwX build/release src/resolver \
    && chmod -R a+rX /root/.bun /opt/rust \
    && chmod -R a+rwX /root/.cargo \
    && chmod a+rx /root \
    && chmod 0777 /opt/rust/tmp \
    && rm -rf .git .gitdir /root/.cache \
    && rm -f "$(command -v git)"

FROM scratch
COPY --from=build /bin /bin
COPY --from=build /etc /etc
COPY --from=build /lib /lib
COPY --from=build /opt /opt
COPY --from=build /root /root
COPY --from=build /sbin /sbin
COPY --from=build /tmp /tmp
COPY --from=build /usr /usr
COPY --from=build /var /var
COPY --from=build /workspace /workspace

ENV GIT_SHA=5187e27669440a72ab1b082f92b7f1b5ca94cfc1 \
    CC=clang-21 \
    CXX=clang++-21 \
    AR=llvm-ar-21 \
    RANLIB=llvm-ranlib-21 \
    LD=lld-21 \
    LLVM_VERSION=21.1.8 \
    CARGO_NET_OFFLINE=true \
    CARGO_PROFILE_RELEASE_LTO=off \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    RUSTUP_HOME=/opt/rust \
    BUN_NO_CORE_DUMP=1 \
    NO_COLOR=1 \
    PATH=/opt/bun/build/release:/opt/rust/bin:/usr/local/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /opt/bun
VOLUME ["/opt/bun/src/resolver", "/opt/bun/build/release", "/opt/rust/tmp", "/root/.cargo"]
ENTRYPOINT []
CMD ["/bin/sh"]
