FROM debian@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd

ARG NODE_REVISION=9df0e9b4d4a5be5ce7506fae44acb6667bb68d6b
ENV DEBIAN_FRONTEND=noninteractive \
    CC=gcc \
    CXX=g++ \
    LDFLAGS=-fuse-ld=lld \
    PYTHON=/usr/bin/python3 \
    NODE_TEST_NO_INTERNET=1 \
    NO_COLOR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential lld ninja-build python3 time \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 2000 --user-group --no-create-home --shell /usr/sbin/nologin sandbox

COPY image-source /opt/node
WORKDIR /opt/node

RUN printf '%s\n' "$NODE_REVISION" > source-revision.txt \
    && ./configure --ninja --without-npm --without-amaro --without-ssl --without-intl --without-inspector

RUN python3 -c 'import pathlib,subprocess,time; t=time.perf_counter(); subprocess.run(["ninja","-C","out/Release","node","-j2"],check=True); pathlib.Path("clean-build-seconds.txt").write_text(f"{time.perf_counter()-t:.6f}\n")' \
    && out/Release/node -p 'process.versions.node' \
    && python3 tools/test.py --mode=release parallel/test-whatwg-url-custom-parsing parallel/test-url-format-whatwg \
    && chmod -R a+rwX /opt/node/out /opt/node/src /opt/node/lib/internal/url.js /opt/node/deps/ada \
    && rm -f /usr/bin/git

ENV PATH=/opt/node/out/Release:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
VOLUME ["/opt/node"]
ENTRYPOINT []
CMD ["/bin/sh"]
