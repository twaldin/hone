#include "simdjson.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <string_view>
#include <vector>

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

// Cheap word-wise hasher with the same event interface as event_hash. Used
// ONLY to fold perturbed timed iterations into the CHAIN line, so the
// per-iteration validation traversal stays cheap and the timed loop remains
// dominated by the parser under measurement. The pristine EVENTS line (the
// protected-oracle payload) still uses event_hash above, byte for byte.
struct chain_hash {
  uint64_t h{0x51afd7ed558ccd9eULL};

  void bytes(const void *data, size_t size) {
    const auto *p = static_cast<const uint8_t *>(data);
    while (size >= 8) {
      uint64_t word;
      std::memcpy(&word, p, 8);
      h = (h ^ word) * 0x2545f4914f6cdd1dULL;
      h ^= h >> 31;
      p += 8;
      size -= 8;
    }
    if (size) {
      uint64_t word = uint64_t(size) << 56;
      std::memcpy(&word, p, size);
      h = (h ^ word) * 0x2545f4914f6cdd1dULL;
      h ^= h >> 31;
    }
  }
  void tag(char value) { h = (h ^ uint8_t(value)) * 0x100000001b3ULL; }
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
};

template<class H>
static void dom_events(dom::element value, H &hash) {
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

template<class T, class H>
static void ondemand_events(T &&value, H &hash) {
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

// ---------------------------------------------------------------------------
// Identity-distinct timed iterations.
//
// Repeating the timed loop over IDENTICAL bytes would let candidate-linked
// code recognize a repeated buffer and replay a memoized result instead of
// parsing. Before every timed iteration after the first, this TRUSTED,
// parser-independent code rewrites a strided sample of value bytes in place:
//   * inside strings: ASCII letters/digits rotate within their class
//     (escape sequences, including \uXXXX, are skipped);
//   * inside numbers: digits whose PREDECESSOR is also a digit rotate DOWN
//     (never up, never the leading digit), so digit count, token structure,
//     and numeric range all stay safe — the perturbed document keeps the
//     pristine document's size and structural profile exactly.
// The rewrite is a pure function of (site index, iteration), so the candidate
// and reference binaries parse the SAME variant sequence and their per-
// iteration event chains are comparable.
// ---------------------------------------------------------------------------

struct perturb_site {
  uint32_t pos;
  uint8_t base;
  uint8_t kind;  // 0=a-z in string, 1=A-Z in string, 2=0-9 in string, 3=non-leading digit in number
};

// Enumerate eligible sites without storing them: invokes visit(pos, base, kind)
// for every perturbable byte, in document order. Two-pass callers keep peak
// memory tiny (the RSS gate covers the harness process, so the site machinery
// must not disturb the frozen peak-RSS baseline).
template<class V>
static void scan_sites(const uint8_t *buf, size_t len, V &&visit) {
  bool in_string = false;
  size_t i = 0;
  while (i < len) {
    const uint8_t c = buf[i];
    if (in_string) {
      if (c == '\\') {
        i += (i + 1 < len && buf[i + 1] == 'u') ? 6 : 2;
        continue;
      }
      if (c == '"') {
        in_string = false;
        ++i;
        continue;
      }
      if (c >= 'a' && c <= 'z') {
        visit(i, c, uint8_t(0));
      } else if (c >= 'A' && c <= 'Z') {
        visit(i, c, uint8_t(1));
      } else if (c >= '0' && c <= '9') {
        visit(i, c, uint8_t(2));
      }
      ++i;
      continue;
    }
    if (c == '"') { in_string = true; }
    else if (c >= '1' && c <= '9' && i > 0 && buf[i - 1] >= '0' && buf[i - 1] <= '9') {
      visit(i, c, uint8_t(3));
    }
    ++i;
  }
}

static std::vector<perturb_site> collect_sites(const uint8_t *buf, size_t len) {
  size_t count = 0;
  scan_sites(buf, len, [&](size_t, uint8_t, uint8_t) { ++count; });
  size_t target = len / 128;
  if (target < 256) { target = 256; }
  if (target > 8192) { target = 8192; }
  const size_t step = count > target ? count / target : 1;
  std::vector<perturb_site> kept;
  kept.reserve(count / step + 2);
  size_t ordinal = 0;
  scan_sites(buf, len, [&](size_t pos, uint8_t base, uint8_t kind) {
    if (ordinal % step == 0) { kept.push_back({uint32_t(pos), base, kind}); }
    ++ordinal;
  });
  return kept;
}

static void apply_perturbation(uint8_t *buf, const std::vector<perturb_site> &sites, long it) {
  const uint64_t seed = uint64_t(it) * 0x9e3779b97f4a7c15ULL;
  for (size_t k = 0; k < sites.size(); ++k) {
    const perturb_site &s = sites[k];
    uint64_t r = seed ^ (uint64_t(k) * 0xc2b2ae3d27d4eb4fULL);
    r ^= r >> 29;
    r *= 0xbf58476d1ce4e5b9ULL;
    r ^= r >> 32;
    switch (s.kind) {
      case 0: buf[s.pos] = uint8_t('a' + (uint8_t(s.base - 'a') + r) % 26); break;
      case 1: buf[s.pos] = uint8_t('A' + (uint8_t(s.base - 'A') + r) % 26); break;
      case 2: buf[s.pos] = uint8_t('0' + (uint8_t(s.base - '0') + r) % 10); break;
      default: buf[s.pos] = uint8_t('0' + r % uint64_t(s.base - '0' + 1)); break;
    }
  }
}

static uint64_t fold_chain(uint64_t chain, uint64_t value, long it) {
  chain ^= value + 0x9e3779b97f4a7c15ULL + (uint64_t(it) << 1);
  chain *= 0xff51afd7ed558ccdULL;
  chain ^= chain >> 33;
  return chain;
}

static void print_chain(uint64_t chain, long perturbed) {
  std::cout << "CHAIN:" << std::hex << std::setfill('0') << std::setw(16) << chain
            << std::dec << ':' << perturbed << '\n';
}

int main(int argc, char **argv) {
  // Usage: verify <dom|ondemand|ondemand-many> <file> [iterations]
  //
  // Iteration 1 parses the PRISTINE input on a reused parser and emits the
  // deterministic EVENTS/ERROR line the trusted parent validates against the
  // protected expected-hash table (identical bytes for every iteration
  // count). Every FURTHER iteration first applies the deterministic,
  // structure-preserving value perturbation above, so no two timed iterations
  // parse identical bytes and a memoized replay of an earlier parse cannot
  // stand in for real work. Each perturbed iteration is fully traversed and
  // its event stream folded into a running chain, emitted as a final CHAIN
  // line; the trusted parent requires the candidate's chain to equal the
  // trusted reference's chain at the same iteration count, so every timed
  // iteration is output-validated, never just clocked.
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
  padded_string &input = loaded.value();
  uint8_t *buf = reinterpret_cast<uint8_t *>(const_cast<char *>(input.data()));
  std::vector<perturb_site> sites;
  if (iterations > 1) { sites = collect_sites(buf, input.size()); }
  uint64_t chain = 0x686f6e652d763200ULL;
  try {
    if (std::strcmp(argv[1], "dom") == 0) {
      dom::parser parser;
      dom::element document;
      error_code error = parser.parse(input).get(document);
      if (error) { std::cout << "ERROR:" << int(error) << '\n'; return 0; }
      event_hash hash;
      dom_events(document, hash);
      hash.print();
      for (long it = 1; it < iterations; it++) {
        apply_perturbation(buf, sites, it);
        error = parser.parse(input).get(document);
        if (error) { std::cout << "ERROR:" << int(error) << '\n'; return 0; }
        chain_hash iter_hash;
        dom_events(document, iter_hash);
        chain = fold_chain(chain, iter_hash.h, it);
      }
      print_chain(chain, iterations - 1);
      return 0;
    }
    if (std::strcmp(argv[1], "ondemand") == 0) {
      ondemand::parser parser;
      {
        ondemand::document document;
        error_code error = parser.iterate(input).get(document);
        if (error) { std::cout << "ERROR:" << int(error) << '\n'; return 0; }
        event_hash hash;
        ondemand_events(document, hash);
        hash.print();
      }
      for (long it = 1; it < iterations; it++) {
        apply_perturbation(buf, sites, it);
        ondemand::document document;
        error_code error = parser.iterate(input).get(document);
        if (error) { std::cout << "ERROR:" << int(error) << '\n'; return 0; }
        chain_hash iter_hash;
        ondemand_events(document, iter_hash);
        chain = fold_chain(chain, iter_hash.h, it);
      }
      print_chain(chain, iterations - 1);
      return 0;
    }
    if (std::strcmp(argv[1], "ondemand-many") == 0) {
      ondemand::parser parser;
      {
        ondemand::document_stream documents;
        error_code error = parser.iterate_many(input).get(documents);
        if (error) { std::cout << "ERROR:" << int(error) << '\n'; return 0; }
        event_hash hash;
        hash.tag('M');
        for (auto document : documents) { ondemand_events(document.value(), hash); }
        hash.print();
      }
      for (long it = 1; it < iterations; it++) {
        apply_perturbation(buf, sites, it);
        ondemand::document_stream documents;
        error_code error = parser.iterate_many(input).get(documents);
        if (error) { std::cout << "ERROR:" << int(error) << '\n'; return 0; }
        chain_hash iter_hash;
        iter_hash.tag('M');
        for (auto document : documents) { ondemand_events(document.value(), iter_hash); }
        chain = fold_chain(chain, iter_hash.h, it);
      }
      print_chain(chain, iterations - 1);
      return 0;
    }
  } catch (const simdjson_error &error) {
    std::cout << "ERROR:" << int(error.error()) << '\n';
    return 0;
  }
  return 64;
}
