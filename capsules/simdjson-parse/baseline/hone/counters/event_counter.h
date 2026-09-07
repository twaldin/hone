#pragma once

#include <chrono>
#include <cstddef>
#include <limits>

namespace counters {

struct event_count {
  double seconds{0.0};

  double elapsed_sec() const { return seconds; }
  double elapsed_ns() const { return seconds * 1.0e9; }
  double cycles() const { return 0.0; }
  double instructions() const { return 0.0; }
  double branch_misses() const { return 0.0; }
};

inline event_count operator+(const event_count &a, const event_count &b) {
  return event_count{a.seconds + b.seconds};
}

struct event_aggregate {
  event_count best{std::numeric_limits<double>::infinity()};
  int iterations{0};
  double total_seconds{0.0};

  event_aggregate &operator<<(const event_count &event) {
    total_seconds += event.seconds;
    ++iterations;
    if (event.seconds < best.seconds) { best = event; }
    return *this;
  }

  double elapsed_sec() const { return iterations == 0 ? 0.0 : total_seconds / iterations; }
  double elapsed_ns() const { return elapsed_sec() * 1.0e9; }
  double cycles() const { return 0.0; }
  double instructions() const { return 0.0; }
  double branch_misses() const { return 0.0; }
};

class event_collector {
public:
  using clock = std::chrono::steady_clock;

  void start() { start_ = clock::now(); }
  event_count end() const {
    return event_count{std::chrono::duration<double>(clock::now() - start_).count()};
  }
  bool has_events() const { return false; }

private:
  clock::time_point start_{};
};

} // namespace counters
