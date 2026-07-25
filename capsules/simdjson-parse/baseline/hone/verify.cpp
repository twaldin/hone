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
// Structurally-distinct timed iterations (a sealed per-iteration document bank).
//
// Repeating the timed loop over the SAME bytes -- or over bytes whose
// STRUCTURAL layout never changes -- would let candidate-linked code run the
// expensive stage-1 structural scan once and then replay the resident
// structural index on every later iteration of the reused parser: a large,
// correct-looking wall-clock shortcut that never re-derives the index. To close
// that seam this TRUSTED, parser-independent code derives a fresh document from
// the sealed pristine seed before every timed iteration after the first, so no
// two timed iterations share either their bytes OR their structural mask:
//
//   * VALUE bytes are rotated in place (letters/digits inside strings rotate
//     within their class; non-leading number digits rotate down, never the
//     leading digit, escapes incl. \uXXXX skipped). Token structure and size
//     are preserved by this step, but the parsed events change, so a candidate
//     cannot replay a cached final result keyed on document length.
//
//   * STRUCTURAL characters ({ } [ ] : ,) that sit next to an insignificant
//     whitespace byte have that whitespace relocated to the token's other side
//     for a per-(site,iteration) subset of sites. JSON permits whitespace on
//     either side of every structural token, so the document stays valid and
//     exactly the same size, but the byte OFFSET of each relocated structural
//     character changes. The structural index the parser must produce therefore
//     differs on every iteration and differs from the pristine iteration-1
//     index, so a parser replaying a resident index reads a whitespace byte
//     where a structural operator is expected and yields a wrong event chain
//     the trusted parent rejects.
//
// Both rewrites are pure functions of (site, iteration) over the sealed seed's
// bytes -- never of the current, already-mutated buffer -- so the candidate and
// reference binaries parse the identical variant sequence and their
// per-iteration event chains are comparable.
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

static bool is_json_ws(uint8_t c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static bool is_structural(uint8_t c) {
  return c == '{' || c == '}' || c == '[' || c == ']' || c == ':' || c == ',';
}

// A relocatable-whitespace site: the structural character at `pos` has an
// insignificant whitespace byte immediately adjacent (before it when `before`,
// else after it). Relocating that whitespace to the token's other side keeps
// the document valid and exactly the same size while moving the structural
// character's byte offset by one -- which is what changes the structural index.
struct swap_site {
  uint32_t pos;    // pristine offset of the structural character
  uint8_t sc;      // the structural byte
  uint8_t wc;      // the adjacent whitespace byte
  uint8_t before;  // 1 = whitespace is at pos-1, 0 = whitespace is at pos+1
};

template<class V>
static void scan_swap_sites(const uint8_t *buf, size_t len, V &&visit) {
  bool in_string = false;
  for (size_t i = 0; i < len; ++i) {
    const uint8_t c = buf[i];
    if (in_string) {
      if (c == '\\') { ++i; continue; }
      if (c == '"') { in_string = false; }
      continue;
    }
    if (c == '"') { in_string = true; continue; }
    if (!is_structural(c)) { continue; }
    // Relocate an adjacent whitespace to the token's other side, but only
    // within the SAME 64-byte scan block, so the per-block count of structural
    // characters is preserved (a sound per-block index reuse -- the `improved`
    // control -- stays valid; only the changed block's index entries move).
    // Prefer a following whitespace, fall back to a preceding one.
    if (i + 1 < len && (i % 64) != 63 && is_json_ws(buf[i + 1])) {
      visit(i, c, buf[i + 1], uint8_t(0));
    } else if (i > 0 && (i % 64) != 0 && is_json_ws(buf[i - 1])) {
      visit(i, c, buf[i - 1], uint8_t(1));
    }
  }
}

static std::vector<swap_site> collect_swap_sites(const uint8_t *buf, size_t len) {
  size_t count = 0;
  scan_swap_sites(buf, len, [&](size_t, uint8_t, uint8_t, uint8_t) { ++count; });
  // Keep the relocated-whitespace sample SMALL: a few sites per iteration are
  // enough to make the structural index differ (so a blind resident-index
  // replay is caught), while leaving the vast majority of 64-byte blocks
  // structurally identical so a SOUND per-block index reuse still pays off.
  size_t target = len / 16384;
  if (target < 16) { target = 16; }
  if (target > 128) { target = 128; }
  const size_t step = count > target ? count / target : 1;
  std::vector<swap_site> kept;
  kept.reserve(count / step + 2);
  size_t ordinal = 0;
  long last_used = -1;  // highest byte offset already claimed by a kept site
  scan_swap_sites(buf, len, [&](size_t pos, uint8_t sc, uint8_t wc, uint8_t before) {
    const long lo = long(before ? pos - 1 : pos);
    const long hi = long(before ? pos : pos + 1);
    if (ordinal % step == 0 && lo > last_used) {
      kept.push_back({uint32_t(pos), sc, wc, before});
      last_used = hi;
    }
    ++ordinal;
  });
  return kept;
}

static uint64_t site_mix(uint64_t a, uint64_t b) {
  uint64_t r = a * 0x9e3779b97f4a7c15ULL ^ (b * 0xc2b2ae3d27d4eb4fULL);
  r ^= r >> 29;
  r *= 0xbf58476d1ce4e5b9ULL;
  r ^= r >> 32;
  return r;
}

static void apply_perturbation(uint8_t *buf, const std::vector<perturb_site> &sites, long it) {
  for (size_t k = 0; k < sites.size(); ++k) {
    const perturb_site &s = sites[k];
    const uint64_t r = site_mix(uint64_t(it), uint64_t(k));
    switch (s.kind) {
      case 0: buf[s.pos] = uint8_t('a' + (uint8_t(s.base - 'a') + r) % 26); break;
      case 1: buf[s.pos] = uint8_t('A' + (uint8_t(s.base - 'A') + r) % 26); break;
      case 2: buf[s.pos] = uint8_t('0' + (uint8_t(s.base - '0') + r) % 10); break;
      default: buf[s.pos] = uint8_t('0' + r % uint64_t(s.base - '0' + 1)); break;
    }
  }
}

// Relocate each swap site's whitespace to a per-(site,iteration) side. The
// structural character lands at `pos` (pristine side) or at its neighbour,
// deterministically toggled by the iteration, so the produced structural index
// differs every iteration and always differs from the pristine iteration-1
// layout. Both bytes are drawn from the sealed seed, never from the current
// buffer, so the rewrite is a pure function of (site, iteration).
static void apply_structural(uint8_t *buf, const std::vector<swap_site> &swaps, long it) {
  for (size_t k = 0; k < swaps.size(); ++k) {
    const swap_site &s = swaps[k];
    const size_t neighbor = s.before ? size_t(s.pos) - 1 : size_t(s.pos) + 1;
    const bool swapped = (site_mix(uint64_t(it) ^ 0xd1b54a32d192ed03ULL, uint64_t(k)) & 1u) != 0;
    if (swapped) {
      buf[s.pos] = s.wc;
      buf[neighbor] = s.sc;
    } else {
      buf[s.pos] = s.sc;
      buf[neighbor] = s.wc;
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
  // count). Every FURTHER iteration first applies the deterministic value
  // rotation AND structural-whitespace relocation described above, so no two
  // timed iterations parse identical bytes and none share a structural index:
  // a memoized replay of an earlier parse, or a replay of a resident stage-1
  // structural index, cannot stand in for real work. Each perturbed iteration
  // is fully traversed and its event stream folded into a running chain,
  // emitted as a final CHAIN line; the trusted parent requires the candidate's
  // chain to equal the trusted reference's chain at the same iteration count,
  // so every timed iteration is output-validated, never just clocked.
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
  std::vector<swap_site> swaps;
  if (iterations > 1) {
    sites = collect_sites(buf, input.size());
    swaps = collect_swap_sites(buf, input.size());
  }
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
        apply_structural(buf, swaps, it);
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
        apply_structural(buf, swaps, it);
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
