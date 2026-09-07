// BROKEN diagnostic control: fails the correctness gate. The verdict is
// reported correctly but the transcoded units are corrupted, so the pristine
// payload hash never matches the protected oracle and the evaluator scores it
// zero on every split.
#include "simdutf.h"
#include <cstddef>
#include <cstdint>
#include <string>

extern "C" {

const char *hone_impl_name() {
  static std::string cached = simdutf::get_active_implementation()->name();
  return cached.c_str();
}

long hone_process(const char *buf, size_t len, char16_t *out, int *verdict) {
  size_t n = simdutf::convert_utf8_to_utf16le(buf, len, out);
  if (n == 0 && len != 0) { *verdict = 0; return 0; }
  for (size_t i = 0; i < n; i++) out[i] = char16_t(out[i] ^ 0xFFFF);  // corrupt
  *verdict = 1;
  return static_cast<long>(n);
}

}  // extern "C"
