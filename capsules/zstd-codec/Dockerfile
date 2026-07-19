FROM docker.io/library/debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential=12.9 \
    ca-certificates=20230311+deb12u1 \
    python3=3.11.2-1+b1 \
    util-linux=2.38.1-5+deb12u3 \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 hone \
  && useradd --no-create-home --uid 2000 --shell /usr/sbin/nologin sandbox

WORKDIR /workspace
USER hone
