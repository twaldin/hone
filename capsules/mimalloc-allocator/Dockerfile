FROM docker.io/library/debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential=12.9 \
    cmake=3.25.1-1 \
    ninja-build=1.11.1-2~deb12u1 \
    python3=3.11.2-1+b1 \
    util-linux=2.38.1-5+deb12u3 \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 2000 candidate \
  && useradd --uid 2000 --gid 2000 --no-create-home --shell /usr/sbin/nologin candidate

COPY baseline/LICENSE /usr/share/doc/hone-mimalloc-allocator/LICENSE

ENV LC_ALL=C.UTF-8 LANG=C.UTF-8
WORKDIR /workspace
