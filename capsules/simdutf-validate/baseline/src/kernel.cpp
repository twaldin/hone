// Mutable UTF-8 validation + UTF-8 -> UTF-16LE transcoding driver.
//
// This translation unit and simdutf.cpp form the candidate-tunable surface.
// The driver dispatches to the simdutf SIMD scan/transcode kernels; an
// optimizer may retune either the kernels or how this driver drives them, so
// long as the observable outputs (validation verdict + transcoded UTF-16LE
// bytes) stay byte-identical, which the trusted parent re-checks against the
// pristine reference on every timed iteration.
#include "simdutf.h"
#include <cstddef>
#include <cstdint>
#include <string>

extern "C" {

const char *hone_impl_name() {
  static std::string cached = simdutf::get_active_implementation()->name();
  return cached.c_str();
}

// Validate + transcode UTF-8 -> UTF-16LE into `out` (>= len units).
// Sets *verdict to 1 if the buffer is valid UTF-8 else 0. Returns the number
// of char16_t units written (0 when invalid), or -1 on an internal error.
//
// BASELINE: a defensive, over-validating driver -- validate the buffer, then a
// utf16-length pre-scan, then a fully re-validating conversion pass. Correct,
// but it walks the buffer through the slow validating conversion path and takes
// an extra length pre-scan that a streamlined driver would not.
long hone_process(const char *buf, size_t len, char16_t *out, int *verdict) {
  if (!simdutf::validate_utf8(buf, len)) {                 // pass 1: validate
    *verdict = 0;
    return 0;
  }
  size_t need = simdutf::utf16_length_from_utf8(buf, len);  // pass 2: length
  (void)need;
  size_t n = simdutf::convert_utf8_to_utf16le(buf, len, out);  // pass 3: re-validating convert
  if (n == 0 && len != 0) {
    *verdict = 0;
    return 0;
  }
  *verdict = 1;
  return static_cast<long>(n);
}

}  // extern "C"
