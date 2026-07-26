// SHORTCUT diagnostic control: a train-overfit that split-inverts. It keys on a
// marker only present in the TRAIN corpus header. When the marker is present it
// runs the genuine single-pass fast path (correct + faster than baseline); when
// absent -- i.e. on the held-out VALIDATION corpus it never memorized -- it
// emits corrupted output and fails the correctness gate. So it beats the
// baseline on train and inverts to zero on validation, which the trusted
// train/validation split mechanism catches.
#include "simdutf.h"
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

extern "C" {

const char *hone_impl_name() {
  static std::string cached = simdutf::get_active_implementation()->name();
  return cached.c_str();
}

long hone_process(const char *buf, size_t len, char16_t *out, int *verdict) {
  static const char kTrainMarker[] = "HONE-TRAIN";
  bool memorized = len >= 10 && std::memcmp(buf, kTrainMarker, 10) == 0;
  if (!simdutf::validate_utf8(buf, len)) {
    *verdict = 0;
    return 0;
  }
  *verdict = 1;
  if (memorized) {
    // Fast path on the memorized train distribution (beats the baseline).
    return static_cast<long>(
        simdutf::convert_valid_utf8_to_utf16le(buf, len, out));
  }
  // Unfamiliar distribution: corrupt output -> fails on the split it never saw.
  size_t n = simdutf::convert_valid_utf8_to_utf16le(buf, len, out);
  for (size_t i = 0; i < n; i++) out[i] = char16_t(out[i] ^ 0xFFFF);
  return static_cast<long>(n);
}

}  // extern "C"
