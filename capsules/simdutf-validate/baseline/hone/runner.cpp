// Trusted candidate-invocation driver (EXEC-BOUNDARY authority side).
//
// This binary links NO candidate code at build time. It authenticates the
// parent control channel, and only AFTER that dlopens the candidate shared
// library and resolves its C ABI. The scored measurement loop is driven here,
// but the wall clock and the receipt validation live in the SEPARATE trusted
// parent (eval.py); this process only reports the folded output digest, which
// the parent checks against the pristine reference. Per-iteration perturbation
// parameters and the fold nonce arrive from the parent at CLOCK-START (the GO
// line), AFTER the candidate library is already mapped, so no correct digest
// can be precomputed by a candidate module-init in the untimed window. On a
// go-nonce-scheduled subset of timed iterations a genuinely invalid UTF-8 unit
// is written at a nonce-chosen code point, so the reject path is exercised ON
// the scored path with per-run-unpredictable placement and its verdict is
// captured by the receipt fold.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <sys/syscall.h>

namespace {

// ---- minimal SHA-256 (public-domain style) for the receipt fold ----------
struct Sha256 {
  uint32_t s[8];
  uint64_t bits = 0;
  uint8_t buf[64];
  size_t n = 0;
  Sha256() {
    static const uint32_t iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372,
                                   0xa54ff53a, 0x510e527f, 0x9b05688c,
                                   0x1f83d9ab, 0x5be0cd19};
    memcpy(s, iv, sizeof s);
  }
  static uint32_t ror(uint32_t x, int r) { return (x >> r) | (x << (32 - r)); }
  void block(const uint8_t *p) {
    static const uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
        0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
      w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16) |
             (uint32_t(p[i * 4 + 2]) << 8) | uint32_t(p[i * 4 + 3]);
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5],
             g = s[6], h = s[7];
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = h + S1 + ch + k[i] + w[i];
      uint32_t S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    s[0] += a; s[1] += b; s[2] += c; s[3] += d;
    s[4] += e; s[5] += f; s[6] += g; s[7] += h;
  }
  void update(const void *data, size_t len) {
    const uint8_t *p = static_cast<const uint8_t *>(data);
    bits += uint64_t(len) * 8;
    while (len) {
      size_t take = 64 - n;
      if (take > len) take = len;
      memcpy(buf + n, p, take);
      n += take; p += take; len -= take;
      if (n == 64) { block(buf); n = 0; }
    }
  }
  std::string hex() {
    uint8_t pad[72];
    size_t plen = 0;
    pad[plen++] = 0x80;
    while ((n + plen) % 64 != 56) pad[plen++] = 0;
    uint64_t b = bits;
    uint8_t lenb[8];
    for (int i = 7; i >= 0; i--) { lenb[i] = uint8_t(b); b >>= 8; }
    update(pad, plen);
    // update() already advanced bits; correct by re-adding the length bytes raw
    memcpy(buf + n, lenb, 8); n += 8; block(buf); n = 0;
    static const char *hx = "0123456789abcdef";
    std::string out;
    out.reserve(64);
    for (int i = 0; i < 8; i++)
      for (int j = 3; j >= 0; j--) {
        uint8_t byte = uint8_t(s[i] >> (j * 8));
        out.push_back(hx[byte >> 4]);
        out.push_back(hx[byte & 15]);
      }
    return out;
  }
};

std::string sha_hex(const std::string &data) {
  Sha256 h;
  h.update(data.data(), data.size());
  return h.hex();
}

// ---- candidate C ABI (resolved via dlsym after auth) ---------------------
using impl_name_fn = const char *(*)();
using process_fn = long (*)(const char *, size_t, char16_t *, int *);

// ---- header region reserved from perturbation (split marker lives here) --
constexpr size_t HEADER_RESERVE = 32;

// A code point in the pristine buffer: byte offset + UTF-8 length (1..4).
struct CodePoint {
  uint32_t off;
  uint8_t len;
};

// Decode the pristine buffer into a code-point index (one pass, untimed).
std::vector<CodePoint> index_code_points(const uint8_t *buf, size_t len) {
  std::vector<CodePoint> cps;
  size_t i = 0;
  while (i < len) {
    uint8_t c = buf[i];
    uint8_t l = 1;
    if (c >= 0xF0) l = 4;
    else if (c >= 0xE0) l = 3;
    else if (c >= 0xC0) l = 2;
    if (i + l > len) l = 1;
    cps.push_back({uint32_t(i), l});
    i += l;
  }
  return cps;
}

uint32_t decode_cp(const uint8_t *p, uint8_t len) {
  switch (len) {
    case 1: return p[0];
    case 2: return (uint32_t(p[0] & 0x1F) << 6) | (p[1] & 0x3F);
    case 3: return (uint32_t(p[0] & 0x0F) << 12) | (uint32_t(p[1] & 0x3F) << 6) |
                   (p[2] & 0x3F);
    default: return (uint32_t(p[0] & 0x07) << 18) | (uint32_t(p[1] & 0x3F) << 12) |
                    (uint32_t(p[2] & 0x3F) << 6) | (p[3] & 0x3F);
  }
}

void encode_cp(uint8_t *p, uint8_t len, uint32_t cp) {
  switch (len) {
    case 1: p[0] = uint8_t(cp); break;
    case 2: p[0] = uint8_t(0xC0 | (cp >> 6)); p[1] = uint8_t(0x80 | (cp & 0x3F));
      break;
    case 3: p[0] = uint8_t(0xE0 | (cp >> 12));
      p[1] = uint8_t(0x80 | ((cp >> 6) & 0x3F));
      p[2] = uint8_t(0x80 | (cp & 0x3F)); break;
    default: p[0] = uint8_t(0xF0 | (cp >> 18));
      p[1] = uint8_t(0x80 | ((cp >> 12) & 0x3F));
      p[2] = uint8_t(0x80 | ((cp >> 6) & 0x3F));
      p[3] = uint8_t(0x80 | (cp & 0x3F)); break;
  }
}

uint64_t splitmix64(uint64_t x) {
  x += 0x9E3779B97F4A7C15ULL;
  x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
  x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
  return x ^ (x >> 31);
}

// Rewrite a same-length-valid code point at cp index `idx` for iteration `it`.
// Pure function of (idx, it, seed) over the pristine value; preserves byte
// length and UTF-8 validity, so the buffer stays valid and exactly its size.
void perturb_one(uint8_t *scratch, const uint8_t *pristine, const CodePoint &c,
                 uint64_t seed, long it) {
  if (c.off < HEADER_RESERVE) return;  // never touch the split-marker header
  uint32_t base = decode_cp(pristine + c.off, c.len);
  uint32_t lo, span;
  switch (c.len) {
    case 1:
      // ASCII letters/digits rotate within their class; everything else fixed.
      if (base >= 'a' && base <= 'z') { lo = 'a'; span = 26; }
      else if (base >= 'A' && base <= 'Z') { lo = 'A'; span = 26; }
      else if (base >= '0' && base <= '9') { lo = '0'; span = 10; }
      else return;
      break;
    case 2: lo = 0x80; span = 0x800 - 0x80; break;          // all valid 2-byte
    case 3: lo = 0x800; span = 0xD800 - 0x800; break;        // valid 3-byte, no surrogates
    default: lo = 0x10000; span = 0x110000 - 0x10000; break; // all valid 4-byte
  }
  uint64_t off = splitmix64(seed ^ (uint64_t(c.off) << 20) ^
                            (uint64_t(it) * 0x100000001B3ULL));
  uint32_t nv = lo + uint32_t((uint64_t(base - lo) + off) % span);
  encode_cp(scratch + c.off, c.len, nv);
}

// Overwrite a code-point slot of length `len` with an unambiguously invalid
// UTF-8 unit of the same length, variant-selected by nonce bits `r`:
//   len 1: lone continuation byte, or an unfinished multibyte lead (the byte
//          that follows is always a code-point start, never a continuation);
//   len 2: overlong two-byte form (0xC0/0xC1 lead), or stray continuations;
//   len 3: UTF-16 surrogate code point in a three-byte slot (U+D800..U+DFFF);
//   len 4: code point above U+10FFFF, or an overlong four-byte form.
// Every variant is rejected by any conformant validator regardless of the
// surrounding bytes, so the trusted reference's verdict for the iteration is
// deterministically 0 (and zero transcoded units).
void write_invalid_unit(uint8_t *p, uint8_t len, uint64_t r) {
  switch (len) {
    case 1:
      p[0] = (r & 1) ? uint8_t(0x80 | ((r >> 1) & 0x3F))   // lone continuation
                     : uint8_t(0xE0 | ((r >> 1) & 0x0F));  // truncated lead
      break;
    case 2:
      if (r & 1) {
        p[0] = uint8_t(0xC0 | ((r >> 1) & 1));             // overlong lead
        p[1] = uint8_t(0x80 | ((r >> 2) & 0x3F));
      } else {
        p[0] = uint8_t(0x80 | ((r >> 1) & 0x3F));          // stray continuations
        p[1] = uint8_t(0x80 | ((r >> 7) & 0x3F));
      }
      break;
    case 3:
      p[0] = 0xED;                                         // U+D800..U+DFFF
      p[1] = uint8_t(0xA0 | ((r >> 1) & 0x1F));
      p[2] = uint8_t(0x80 | ((r >> 6) & 0x3F));
      break;
    default:
      if (r & 1) {
        p[0] = 0xF4;                                       // above U+10FFFF
        p[1] = uint8_t(0x90 | ((r >> 1) & 0x2F));
      } else {
        p[0] = 0xF0;                                       // overlong four-byte
        p[1] = uint8_t(0x80 | ((r >> 1) & 0x0F));
      }
      p[2] = uint8_t(0x80 | ((r >> 7) & 0x3F));
      p[3] = uint8_t(0x80 | ((r >> 13) & 0x3F));
      break;
  }
}

// Eight-lane word-wise output fold. Every iteration's transcoded bytes are
// folded in full (so any single-byte deviation from the pristine reference is
// caught), but the eight independent accumulator lanes break the serial
// multiply dependency so the fold streams at ~memory bandwidth -- well under
// the candidate scan/transcode cost, so this trusted common-mode validation
// does not dominate the timed window. Seeded from the go-time fold nonce.
inline void fast_fold(uint64_t h[8], const void *data, size_t bytes) {
  const uint8_t *p = static_cast<const uint8_t *>(data);
  size_t i = 0;
  for (; i + 64 <= bytes; i += 64) {
    for (int j = 0; j < 8; j++) {
      uint64_t w;
      memcpy(&w, p + i + size_t(j) * 8, 8);
      h[j] = (h[j] ^ w) * 0x100000001B3ULL + (h[j] >> 29);
    }
  }
  for (; i < bytes; i++) {
    h[i & 7] = (h[i & 7] ^ p[i]) * 0x100000001B3ULL;
  }
}

std::string read_line(int fd) {
  std::string s;
  char ch;
  while (true) {
    ssize_t r = read(fd, &ch, 1);
    if (r <= 0) return s;
    if (ch == '\n') return s;
    s.push_back(ch);
  }
}

void write_all(int fd, const std::string &s) {
  const char *p = s.data();
  size_t left = s.size();
  while (left) {
    ssize_t w = write(fd, p, left);
    if (w <= 0) return;
    p += w; left -= size_t(w);
  }
}

// Load the candidate library through an in-memory file descriptor where the
// platform supports it. The candidate .so may live on a noexec candidate-
// writable filesystem; copying its bytes into an anonymous memfd and
// dlopen'ing /proc/self/fd/N maps it regardless of the source mount, and keeps
// this trusted runner the sole authority that ever maps candidate code. Falls
// back to a direct path dlopen where memfd is unavailable (developer runs).
void *load_candidate(const char *so_path) {
#if defined(__linux__) && defined(SYS_memfd_create)
  int src = open(so_path, O_RDONLY | O_CLOEXEC);
  if (src >= 0) {
    int mfd = int(syscall(SYS_memfd_create, "hone-candidate", 0u));
    if (mfd >= 0) {
      char chunk[1 << 16];
      ssize_t r;
      bool ok = true;
      while ((r = read(src, chunk, sizeof chunk)) > 0) {
        ssize_t off = 0;
        while (off < r) {
          ssize_t w = write(mfd, chunk + off, size_t(r - off));
          if (w <= 0) { ok = false; break; }
          off += w;
        }
        if (!ok) break;
      }
      close(src);
      if (ok && r == 0) {
        char proc[64];
        snprintf(proc, sizeof proc, "/proc/self/fd/%d", mfd);
        void *h = dlopen(proc, RTLD_NOW | RTLD_LOCAL);
        close(mfd);
        if (h) return h;
      } else {
        close(mfd);
      }
    } else {
      close(src);
    }
  }
#endif
  return dlopen(so_path, RTLD_NOW | RTLD_LOCAL);
}

}  // namespace

int main(int argc, char **argv) {
  // Usage: runner <candidate.so> <corpus_file> <ctrl_read_fd> <resp_write_fd>
  if (argc != 5) return 64;
  const char *so_path = argv[1];
  const char *corpus_path = argv[2];
  int ctrl_fd = atoi(argv[3]);
  int resp_fd = atoi(argv[4]);

  // Load the trusted corpus (untimed; public data, mmapped read-only).
  int cfd = open(corpus_path, O_RDONLY);
  if (cfd < 0) return 66;
  struct stat st;
  if (fstat(cfd, &st) != 0) { close(cfd); return 66; }
  size_t len = size_t(st.st_size);
  std::vector<uint8_t> pristine(len);
  {
    size_t got = 0;
    while (got < len) {
      ssize_t r = read(cfd, pristine.data() + got, len - got);
      if (r <= 0) break;
      got += size_t(r);
    }
    close(cfd);
    if (got != len) return 66;
  }
  std::vector<CodePoint> cps = index_code_points(pristine.data(), len);

  // --- Control-channel authentication (TRUSTED main, before any candidate
  //     code is mapped). The AUTH nonce is consumed and echoed here; the
  //     candidate library is not yet loaded, so a candidate module-init cannot
  //     participate in this step. ---
  std::string auth = read_line(ctrl_fd);   // "AUTH <hex>"
  const std::string kAuthPrefix = "AUTH ";
  if (auth.rfind(kAuthPrefix, 0) != 0) return 67;
  std::string nonce = auth.substr(kAuthPrefix.size());
  write_all(resp_fd, "READY " + sha_hex("hone-runner-v1:" + nonce) + "\n");

  // --- EXEC BOUNDARY: only now is candidate code mapped. Any .init_array here
  //     runs AFTER auth and BEFORE the go-token exists. ---
  void *handle = load_candidate(so_path);
  if (!handle) { write_all(resp_fd, std::string("FAIL dlopen ") + dlerror() + "\n"); return 68; }
  auto impl_name = reinterpret_cast<impl_name_fn>(dlsym(handle, "hone_impl_name"));
  auto process = reinterpret_cast<process_fn>(dlsym(handle, "hone_process"));
  if (!impl_name || !process) {
    write_all(resp_fd, "FAIL dlsym\n");
    return 69;
  }
  write_all(resp_fd, "LOADED\n");

  // --- CLOCK-START payload: perturbation seed, fold nonce, iteration count,
  //     delivered by the parent only now. ---
  std::string go = read_line(ctrl_fd);  // "GO <fold_nonce_hex> <seed> <iters>"
  const std::string kGoPrefix = "GO ";
  if (go.rfind(kGoPrefix, 0) != 0) return 70;
  std::string rest = go.substr(kGoPrefix.size());
  char fold_nonce[128];
  unsigned long long seed = 0;
  long iters = 0;
  if (sscanf(rest.c_str(), "%127s %llu %ld", fold_nonce, &seed, &iters) != 3)
    return 71;
  if (iters < 1) return 72;

  // Scratch buffer we perturb in place; out buffer sized to the safe upper
  // bound (utf16 units <= utf8 bytes for every code point).
  std::vector<uint8_t> scratch(pristine.begin(), pristine.end());
  std::vector<char16_t> out(len ? len : 1);

  // Running 512-bit (8-lane) output fold, seeded from the go-time fold nonce so
  // the receipt digest is bound to per-iteration data delivered at clock-start.
  uint64_t h[8];
  {
    Sha256 seed_h;
    seed_h.update(fold_nonce, strlen(fold_nonce));
    std::string s = seed_h.hex();  // 64 hex chars = 32 bytes -> 4 seeds; expand
    for (int j = 0; j < 8; j++) {
      Sha256 lane;
      char tag = char('0' + j);
      lane.update(&tag, 1);
      lane.update(s.data(), s.size());
      std::string ls = lane.hex();
      memcpy(&h[j], ls.data(), 8);
    }
  }
  std::string payload_hex;

  // ---- go-nonce-scheduled reject-path exercise ----------------------------
  // On roughly 1/8 of the timed iterations (nonce-selected, plus one FORCED
  // iteration per leg so even the shortest calibration legs carry at least
  // one), a genuinely invalid unit is written at a nonce-chosen code point
  // before the candidate call and the original bytes are restored afterwards.
  // The schedule is a pure function of the go-time seed (identical for the
  // reference and candidate legs of a pair; unpredictable before clock-start),
  // the trusted reference deterministically rejects those iterations
  // (verdict=0, zero units), and the verdict byte is folded into the receipt
  // digest -- so a driver that skips validation, converts without validating,
  // or keys on memorized malformed shapes diverges from the reference digest.
  // Iteration 0 (the pristine payload oracle) is never injected.
  size_t first_body = 0;
  while (first_body < cps.size() && cps[first_body].off < HEADER_RESERVE)
    first_body++;
  const size_t body_count = cps.size() - first_body;
  long forced_it = -1;
  if (iters >= 2 && body_count > 0)
    forced_it = 1 + long(splitmix64(uint64_t(seed) ^ 0xF0CE51A7C0DE0001ULL) %
                         uint64_t(iters - 1));

  for (long it = 0; it < iters; it++) {
    if (it > 0) {
      // Rewrite only a sparse, rotating subset each iteration: enough to make
      // every timed iteration byte-distinct (defeating whole-output memoing)
      // while keeping this trusted, common-mode perturbation cheap relative to
      // the candidate scan/transcode under measurement.
      constexpr size_t kStride = 64;
      for (size_t k = size_t(it) % kStride; k < cps.size(); k += kStride)
        perturb_one(scratch.data(), pristine.data(), cps[k], uint64_t(seed), it);
    }
    uint8_t saved[4];
    const CodePoint *inj = nullptr;
    if (it > 0 && body_count > 0) {
      uint64_t r = splitmix64(uint64_t(seed) ^ 0x1BADB002DEADF00DULL ^
                              (uint64_t(it) * 0x9E3779B97F4A7C15ULL));
      if (it == forced_it || (r & 7) == 0) {
        inj = &cps[first_body + size_t((r >> 3) % body_count)];
        memcpy(saved, scratch.data() + inj->off, inj->len);
        write_invalid_unit(scratch.data() + inj->off, inj->len, r >> 24);
      }
    }
    const char *ibuf = reinterpret_cast<const char *>(scratch.data());
    int ok = 0;
    long n = process(ibuf, len, out.data(), &ok);
    if (inj) memcpy(scratch.data() + inj->off, saved, inj->len);
    if (n < 0) { write_all(resp_fd, "FAIL process\n"); return 73; }
    if (!ok) n = 0;
    uint8_t vb = uint8_t(ok);
    h[it & 7] ^= uint64_t(vb) * 0x2545F4914F6CDD1DULL + uint64_t(it);
    fast_fold(h, out.data(), size_t(n) * sizeof(char16_t));
    if (it == 0) {
      // Pristine payload the parent validates against the protected oracle.
      Sha256 p;
      p.update(&vb, 1);
      p.update(out.data(), size_t(n) * sizeof(char16_t));
      payload_hex = p.hex();
    }
  }

  // Combine the eight lanes into a 128-bit receipt digest.
  uint64_t d0 = 0, d1 = 0;
  for (int j = 0; j < 8; j++) {
    d0 = (d0 ^ h[j]) * 0x100000001B3ULL;
    d1 = (d1 + h[j]) * 0x9E3779B97F4A7C15ULL + (d1 >> 31);
  }
  char dgbuf[40];
  snprintf(dgbuf, sizeof dgbuf, "%016llx%016llx",
           static_cast<unsigned long long>(d0),
           static_cast<unsigned long long>(d1));
  std::string dg = dgbuf;
  write_all(resp_fd, std::string("RESULT ") + impl_name() + " " + payload_hex +
                         " " + dg + "\n");
  dlclose(handle);
  return 0;
}
