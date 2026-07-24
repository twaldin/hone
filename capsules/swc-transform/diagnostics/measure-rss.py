#!/usr/bin/env python3
import json
import math
import os
import sys
import time

binary = sys.argv[1]
roots = {"train": sys.argv[2], "validation": sys.argv[3]}
cases = (("javascript.js", "js"), ("typescript.ts", "ts"), ("react.tsx", "tsx"))
result = {}
for split, root in roots.items():
    rows = []
    for filename, kind in cases:
        timings = []
        peak = 0
        for repetition in range(3):
            output_path = f"/tmp/{split}-{filename}-{repetition}.json"
            output_fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            started = time.monotonic_ns()
            pid = os.fork()
            if pid == 0:
                os.dup2(output_fd, 1)
                os.close(output_fd)
                os.execv(binary, [binary, "bench", f"{root}/{filename}", kind])
            os.close(output_fd)
            _, status, usage = os.wait4(pid, 0)
            timings.append(float(time.monotonic_ns() - started))
            with open(output_path, "rb") as stream:
                output = stream.read()
            os.unlink(output_path)
            if os.waitstatus_to_exitcode(status) != 0:
                raise SystemExit(f"{split}/{filename} failed")
            json.loads(output)
            peak = max(peak, int(usage.ru_maxrss))
        q = 1_000_000_000.0 / math.exp(sum(math.log(value) for value in timings) / len(timings))
        rows.append({"file": filename, "peakRssKb": peak, "q": q})
    result[split] = rows
print(json.dumps(result, sort_keys=True, separators=(",", ":")))
