FROM golang:1.26.4-bookworm@sha256:b305420a68d0f229d91eb3b3ed9e519fcf2cf5461da4bef997bf927e8c0bfd2b

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs python3 \
    && rm -rf /var/lib/apt/lists/*

ENV GOTOOLCHAIN=local \
    GOPROXY=off \
    GOSUMDB=off \
    GOFLAGS=-mod=vendor \
    CGO_ENABLED=0 \
    HOME=/tmp/hone-home \
    GOCACHE=/tmp/hone-go-cache-anchor \
    GOCACHEPROG=/usr/local/bin/hone-go-cache

COPY toolchain/cacheprog.py /usr/local/bin/hone-go-cache
COPY baseline /workspace
RUN chmod 0555 /usr/local/bin/hone-go-cache \
    && mkdir -p /opt/hone-go-cache \
    && cd /workspace \
    && GOCACHE=/opt/hone-go-cache GOCACHEPROG= go test -c -trimpath -ldflags='-s -w' -o /tmp/js-parser.test ./internal/js_parser \
    && (cd /workspace/internal/js_parser && /tmp/js-parser.test -test.timeout=150s) \
    && GOCACHE=/opt/hone-go-cache GOCACHEPROG= go test -c -trimpath -ldflags='-s -w' -o /tmp/bundler.test ./internal/bundler_tests \
    && (cd /workspace/internal/bundler_tests && /tmp/bundler.test -test.timeout=150s) \
    && rm -f /tmp/js-parser.test /tmp/bundler.test \
    && GOCACHE=/opt/hone-go-cache GOCACHEPROG= go build -trimpath -ldflags='-s -w' ./cmd/esbuild


WORKDIR /workspace
