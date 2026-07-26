FROM debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential=12.9 \
      python3=3.11.2-1+b1 \
      util-linux=2.38.1-5+deb12u3 \
      time=1.9-0.2 \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 2000 candidate \
 && useradd --uid 2000 --gid 2000 --no-create-home --shell /usr/sbin/nologin candidate

# Pre-build the TRUSTED pristine reference library and the trusted runner from
# the frozen trusted sources. The reference is the interleaved yardstick and is
# never candidate-linked; the runner links NO candidate code and only dlopens
# the candidate library at run time after authenticating the control channel.
COPY baseline/include /opt/hone-src/include
COPY baseline/src /opt/hone-src/src
COPY baseline/hone /opt/hone-src/hone
RUN mkdir -p /opt/hone-objects \
 && cxxflags='-std=c++17 -O3 -DNDEBUG' \
 && g++ $cxxflags -I/opt/hone-src/include -fPIC -c /opt/hone-src/src/simdutf.cpp -o /tmp/ref-simdutf.o \
 && g++ $cxxflags -I/opt/hone-src/include -fPIC -c /opt/hone-src/src/kernel.cpp -o /tmp/ref-kernel.o \
 && g++ -shared /tmp/ref-kernel.o /tmp/ref-simdutf.o -o /opt/hone-objects/libsimdutf_reference.so \
 && g++ $cxxflags /opt/hone-src/hone/runner.cpp -ldl -o /opt/hone-objects/runner \
 && chmod 0644 /opt/hone-objects/libsimdutf_reference.so \
 && chmod 0755 /opt/hone-objects/runner \
 && rm -rf /opt/hone-src /tmp/ref-simdutf.o /tmp/ref-kernel.o

COPY baseline/LICENSE-APACHE baseline/LICENSE-MIT baseline/AUTHORS baseline/CONTRIBUTORS /usr/share/doc/hone-simdutf-validate/

ENV LC_ALL=C.UTF-8 LANG=C.UTF-8
