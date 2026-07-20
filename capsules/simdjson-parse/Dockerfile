FROM debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS object-builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential=12.9 \
      libbenchmark-dev=1.7.1-1 \
 && rm -rf /var/lib/apt/lists/*

COPY baseline/include /build-src/include
COPY baseline/src /build-src/src
COPY baseline/benchmark /build-src/benchmark
COPY baseline/tests /build-src/tests
COPY baseline/hone/counters /build-src/hone/counters
COPY baseline/hone/verify.cpp /build-src/hone/verify.cpp
RUN mkdir -p /opt/hone-objects/tests \
 && cxxflags='-std=c++20 -O2 -DNDEBUG -DSIMDJSON_BENCHMARK_DATA_DIR="/dev/shm/corpus/" -I/build-src/hone -I/build-src/include -I/build-src/src -I/build-src/tests -I/build-src/benchmark' \
 && g++ $cxxflags -c /build-src/benchmark/dom/parse.cpp -o /opt/hone-objects/parse.o \
 && g++ $cxxflags -c /build-src/benchmark/bench_ondemand.cpp -o /opt/hone-objects/bench_ondemand.o \
 && g++ $cxxflags -c /build-src/hone/verify.cpp -o /opt/hone-objects/verify.o \
 && tests='dom/random_string_number_tests dom/basictests dom/document_stream_tests dom/document_stream_fuzz_tests dom/document_tests dom/unpadded_tests dom/errortests dom/extracting_values_example dom/integer_tests dom/big_integer_tests dom/nan_inf_tests dom/json_path_tests ondemand/ondemand_log_tests ondemand/ondemand_tostring_tests ondemand/ondemand_active_tests ondemand/ondemand_array_tests ondemand/ondemand_array_error_tests ondemand/ondemand_compilation_tests ondemand/ondemand_document_stream_tests ondemand/ondemand_document_stream_fuzz_tests ondemand/ondemand_error_tests ondemand/ondemand_error_location_tests ondemand/ondemand_json_pointer_tests ondemand/ondemand_json_path_tests ondemand/ondemand_key_string_tests ondemand/ondemand_misc_tests ondemand/ondemand_nan_inf_tests ondemand/ondemand_number_tests ondemand/ondemand_number_in_string_tests ondemand/ondemand_object_tests ondemand/ondemand_object_find_field_tests ondemand/ondemand_object_error_tests ondemand/ondemand_ordering_tests ondemand/ondemand_parse_api_tests ondemand/ondemand_readme_examples ondemand/ondemand_scalar_tests ondemand/ondemand_to_string ondemand/ondemand_twitter_tests ondemand/ondemand_wrong_type_error_tests ondemand/ondemand_iterate_many_csv ondemand/ondemand_padded_input ondemand/ondemand_cacheline ondemand/ondemand_unknown_tests ondemand/ondemand_wildcard_tests' \
 && : > /opt/hone-objects/test-objects.txt \
 && for test in $tests; do name="$(basename "$test")"; g++ $cxxflags -c "/build-src/tests/$test.cpp" -o "/opt/hone-objects/tests/$name.o"; echo "$name" >> /opt/hone-objects/test-objects.txt; done

FROM debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential=12.9 \
      cmake=3.25.1-1 \
      ninja-build=1.11.1-2~deb12u1 \
      python3=3.11.2-1+b1 \
      util-linux=2.38.1-5+deb12u3 \
      time=1.9-0.2 \
      libbenchmark-dev=1.7.1-1 \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 2000 candidate \
 && useradd --uid 2000 --gid 2000 --no-create-home --shell /usr/sbin/nologin candidate

COPY --from=object-builder /opt/hone-objects /opt/hone-objects
COPY baseline/LICENSE baseline/LICENSE-MIT baseline/AUTHORS baseline/CONTRIBUTORS /usr/share/doc/hone-simdjson-parse/

ENV LC_ALL=C.UTF-8 LANG=C.UTF-8
