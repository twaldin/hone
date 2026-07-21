#include "simdjson.h"

#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <string_view>

using namespace simdjson;

struct event_hash {
  uint64_t first{1469598103934665603ULL};
  uint64_t second{7809847782465536322ULL};
  uint64_t events{0};

  void bytes(const void *data, size_t size) {
    const auto *p = static_cast<const uint8_t *>(data);
    for (size_t i = 0; i < size; ++i) {
      first = (first ^ p[i]) * 1099511628211ULL;
      second ^= uint64_t(p[i]) + 0x9e3779b97f4a7c15ULL + (second << 6) + (second >> 2);
    }
  }
  void tag(char value) { bytes(&value, 1); ++events; }
  void string(char kind, std::string_view value) {
    tag(kind);
    uint64_t size = value.size();
    bytes(&size, sizeof(size));
    bytes(value.data(), value.size());
  }
  template<class T> void scalar(char kind, T value) {
    tag(kind);
    bytes(&value, sizeof(value));
  }
  void print() const {
    std::cout << "EVENTS:" << std::hex << std::setfill('0')
              << std::setw(16) << first << std::setw(16) << second
              << ':' << std::dec << events << '\n';
  }
};

static void dom_events(dom::element value, event_hash &hash) {
  switch (value.type()) {
    case dom::element_type::ARRAY:
      hash.tag('[');
      for (dom::element child : dom::array(value)) { dom_events(child, hash); }
      hash.tag(']');
      return;
    case dom::element_type::OBJECT:
      hash.tag('{');
      for (dom::key_value_pair field : dom::object(value)) {
        hash.string('K', field.key);
        dom_events(field.value, hash);
      }
      hash.tag('}');
      return;
    case dom::element_type::INT64:
      hash.scalar('I', int64_t(value));
      return;
    case dom::element_type::UINT64:
      hash.scalar('U', uint64_t(value));
      return;
    case dom::element_type::DOUBLE:
      hash.scalar('D', double(value));
      return;
    case dom::element_type::STRING:
      hash.string('S', std::string_view(value));
      return;
    case dom::element_type::BOOL:
      hash.scalar('B', bool(value));
      return;
    case dom::element_type::NULL_VALUE:
      hash.tag('N');
      return;
  }
}

template<class T>
static void ondemand_events(T &&value, event_hash &hash) {
  switch (value.type()) {
    case ondemand::json_type::array:
      hash.tag('[');
      for (auto child : value.get_array()) { ondemand_events(child.value(), hash); }
      hash.tag(']');
      return;
    case ondemand::json_type::object:
      hash.tag('{');
      for (auto field : value.get_object()) {
        hash.string('K', field.unescaped_key());
        ondemand_events(field.value(), hash);
      }
      hash.tag('}');
      return;
    case ondemand::json_type::number: {
      ondemand::number number = value.get_number();
      switch (number.get_number_type()) {
        case ondemand::number_type::signed_integer:
          hash.scalar('I', number.get_int64());
          return;
        case ondemand::number_type::unsigned_integer:
          hash.scalar('U', number.get_uint64());
          return;
        case ondemand::number_type::floating_point_number:
          hash.scalar('D', number.get_double());
          return;
      }
      return;
    }
    case ondemand::json_type::string:
      hash.string('S', value.get_string());
      return;
    case ondemand::json_type::boolean:
      hash.scalar('B', bool(value.get_bool()));
      return;
    case ondemand::json_type::null:
      if (!value.is_null()) { throw simdjson_error(INCORRECT_TYPE); }
      hash.tag('N');
      return;
    case ondemand::json_type::unknown:
      throw simdjson_error(TAPE_ERROR);
  }
}

int main(int argc, char **argv) {
  // Usage: verify <dom|ondemand|ondemand-many> <file> [iterations]
  //
  // The optional iteration count makes this harness re-parse the SAME input
  // with a REUSED parser (no per-iteration allocation), so the trusted parent
  // process can wall-clock the pure parse loop from OUTSIDE the candidate-
  // linked executable. The emitted EVENTS/ERROR line is deterministic and
  // therefore identical for any iteration count: correctness validation and
  // throughput measurement share one non-self-reporting harness.
  if (argc < 3 || argc > 4) { return 64; }
  long iterations = 1;
  if (argc == 4) {
    iterations = std::strtol(argv[3], nullptr, 10);
    if (iterations < 1) { return 65; }
  }
  std::cout << "IMPL:" << get_active_implementation()->name() << '\n';
  auto loaded = padded_string::load(argv[2]);
  if (loaded.error()) {
    std::cout << "ERROR:" << int(loaded.error()) << '\n';
    return 0;
  }
  try {
    event_hash hash;
    if (std::strcmp(argv[1], "dom") == 0) {
      // DOM timing iterations are parse-only (stage 1 + stage 2 on a reused
      // parser); the full event traversal + hash runs once, over the FINAL
      // parse, so the emitted line still validates the complete DOM while the
      // timed loop stays parser-dominated.
      dom::parser parser;
      dom::element document;
      for (long it = 0; it < iterations; it++) {
        error_code error = parser.parse(loaded.value()).get(document);
        if (error) { std::cout << "ERROR:" << int(error) << '\n'; return 0; }
      }
      dom_events(document, hash);
      hash.print();
      return 0;
    }
    if (std::strcmp(argv[1], "ondemand") == 0) {
      ondemand::parser parser;
      for (long it = 0; it < iterations; it++) {
        hash = event_hash{};
        ondemand::document document;
        error_code error = parser.iterate(loaded.value()).get(document);
        if (error) { std::cout << "ERROR:" << int(error) << '\n'; return 0; }
        ondemand_events(document, hash);
      }
      hash.print();
      return 0;
    }
    if (std::strcmp(argv[1], "ondemand-many") == 0) {
      ondemand::parser parser;
      for (long it = 0; it < iterations; it++) {
        hash = event_hash{};
        ondemand::document_stream documents;
        error_code error = parser.iterate_many(loaded.value()).get(documents);
        if (error) { std::cout << "ERROR:" << int(error) << '\n'; return 0; }
        hash.tag('M');
        for (auto document : documents) { ondemand_events(document.value(), hash); }
      }
      hash.print();
      return 0;
    }
  } catch (const simdjson_error &error) {
    std::cout << "ERROR:" << int(error.error()) << '\n';
    return 0;
  }
  return 64;
}
