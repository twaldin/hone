import os,select,signal,time,json
_WIRE=262144
def _kill(child):
    for kill in (os.killpg, os.kill):
        try:
            kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass

def _supervise(child, reader, deadline):
    data, eof, exited = b"", False, False
    while not (eof and exited) and len(data) <= _WIRE:
        remaining = deadline - time.monotonic()
        if not exited and os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
            exited = True
            # Stray descendants must not hold the frame open.
            _kill(child)
        if remaining <= 0:
            return data if exited else None
        if eof:
            time.sleep(min(remaining, 0.01))
        elif select.select([reader], [], [], min(remaining, 0.01))[0]:
            chunk = os.read(reader, 65536)
            eof, data = not chunk, data + chunk
    return data

results = []
frames = [("pass", {"results": [{"t": "int", "v": "0x3"}, {"t": "int", "v": "0x4"}]}),
          ("candidate-error", {"failure": {"reason": "call 0 raised TypeError"}})]
for label, frame in frames:
    expected = (json.dumps(frame) + "\n").encode()
    reader, writer = os.pipe()
    ready_reader, ready_writer = os.pipe()
    child = os.fork()
    if child == 0:
        os.setpgid(0, 0)
        os.close(reader)
        descendant = os.fork()
        if descendant == 0:
            os.close(ready_reader)
            os.setsid()
            os.write(ready_writer, b"R")
            os.close(ready_writer)
            time.sleep(30)
            os._exit(0)
        os.close(ready_writer)
        assert os.read(ready_reader, 1) == b"R"
        os.close(ready_reader)
        os.write(writer, expected)
        os.close(writer)
        os._exit(0)
    os.close(writer)
    os.close(ready_writer)
    os.close(ready_reader)
    observed_exit = os.waitid(os.P_PID, child, os.WEXITED | os.WNOWAIT)
    observed_at = time.monotonic()
    deadline = observed_at + 0.05
    time.sleep(0.1)
    resumed_at = time.monotonic()
    readable_before = bool(select.select([reader], [], [], 0)[0])
    captured = _supervise(child, reader, deadline)
    queued = os.read(reader, len(expected))
    status = os.waitpid(child, 0)[1]
    os.close(reader)
    results.append({"case": label, "child_exit": os.waitstatus_to_exitcode(status),
                    "exit_observed_before_deadline": observed_exit is not None and observed_at < deadline,
                    "supervisor_resumed_after_deadline": resumed_at > deadline,
                    "pipe_readable_before_supervision": readable_before,
                    "captured_hex": captured.hex() if captured is not None else None,
                    "queued_after_return_hex": queued.hex(), "expected_hex": expected.hex()})
print(json.dumps(results), flush=True)
