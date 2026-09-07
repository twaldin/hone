// IMPROVED diagnostic control: genuine, observation-preserving work reduction.
// The redundant utf16-length pre-scan is dropped and, once validity is
// established, the transcode uses the non-validating fast conversion path
// instead of the slow re-validating one -- so the driver walks the buffer once
// to validate and once to transcode (fast), rather than validate + length +
// re-validating convert. Output and verdict are byte-identical to the baseline
// on every input; the trusted parent re-checks the folded digest against the
// pristine reference every timed iteration, so the speedup cannot trade away
// correctness.
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
  if (!simdutf::validate_utf8(buf, len)) {   // verdict
    *verdict = 0;
    return 0;
  }
  size_t n = simdutf::convert_valid_utf8_to_utf16le(buf, len, out);  // fast path
  *verdict = 1;
  return static_cast<long>(n);
}

}  // extern "C"
