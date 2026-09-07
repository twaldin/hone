// NAIVE diagnostic control: correct but slow. A hand-written scalar strict
// UTF-8 validator/transcoder processed one code point at a time, no
// vectorization. Byte-identical output/verdict to the baseline, but far slower
// than the SIMD kernels, so it must score below the baseline while still
// passing every correctness gate.
#include "simdutf.h"
#include <cstddef>
#include <cstdint>
#include <string>

extern "C" {

const char *hone_impl_name() {
  static std::string cached = simdutf::get_active_implementation()->name();
  return cached.c_str();
}

static long decode_scalar(const unsigned char *p, size_t len, size_t i,
                          uint32_t *cp) {
  unsigned char c = p[i];
  if (c < 0x80) { *cp = c; return 1; }
  if ((c & 0xE0) == 0xC0) {
    if (i + 1 >= len || (p[i + 1] & 0xC0) != 0x80) return -1;
    uint32_t v = (uint32_t(c & 0x1F) << 6) | (p[i + 1] & 0x3F);
    if (v < 0x80) return -1;
    *cp = v; return 2;
  }
  if ((c & 0xF0) == 0xE0) {
    if (i + 2 >= len || (p[i + 1] & 0xC0) != 0x80 || (p[i + 2] & 0xC0) != 0x80)
      return -1;
    uint32_t v = (uint32_t(c & 0x0F) << 12) | (uint32_t(p[i + 1] & 0x3F) << 6) |
                 (p[i + 2] & 0x3F);
    if (v < 0x800) return -1;
    if (v >= 0xD800 && v <= 0xDFFF) return -1;
    *cp = v; return 3;
  }
  if ((c & 0xF8) == 0xF0) {
    if (i + 3 >= len || (p[i + 1] & 0xC0) != 0x80 || (p[i + 2] & 0xC0) != 0x80 ||
        (p[i + 3] & 0xC0) != 0x80)
      return -1;
    uint32_t v = (uint32_t(c & 0x07) << 18) | (uint32_t(p[i + 1] & 0x3F) << 12) |
                 (uint32_t(p[i + 2] & 0x3F) << 6) | (p[i + 3] & 0x3F);
    if (v < 0x10000 || v > 0x10FFFF) return -1;
    *cp = v; return 4;
  }
  return -1;
}

long hone_process(const char *buf, size_t len, char16_t *out, int *verdict) {
  const unsigned char *p = reinterpret_cast<const unsigned char *>(buf);
  // Pass 1: validate.
  {
    size_t i = 0; uint32_t cp;
    while (i < len) {
      long adv = decode_scalar(p, len, i, &cp);
      if (adv < 0) { *verdict = 0; return 0; }
      i += size_t(adv);
    }
  }
  // Pass 2: transcode.
  size_t i = 0, o = 0; uint32_t cp;
  while (i < len) {
    long adv = decode_scalar(p, len, i, &cp);
    if (adv < 0) { *verdict = 0; return 0; }
    i += size_t(adv);
    if (cp <= 0xFFFF) {
      out[o++] = char16_t(cp);
    } else {
      cp -= 0x10000;
      out[o++] = char16_t(0xD800 | (cp >> 10));
      out[o++] = char16_t(0xDC00 | (cp & 0x3FF));
    }
  }
  *verdict = 1;
  return static_cast<long>(o);
}

}  // extern "C"
