from __future__ import annotations

import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import tempfile
import time
import uuid
from collections.abc import Callable

from .runtime import IMAGE, ProviderRefusal

MAX_CALLS = 2
MAX_OUTPUT_TOKENS = 4096
MAX_PROMPT_BYTES = 65536
MAX_WIRE_BYTES = 262144
SEED_PROGRAM = '''import json, sys
row = json.loads(sys.stdin.readline())
print(json.dumps({"type": "model", "messages": [{"role": "system", "content": row["prompt"]}, {"role": "user", "content": row["input"]}], "max_tokens": 4096}), flush=True)
answer = json.loads(sys.stdin.readline())["text"]
print(json.dumps({"type": "result", "code": answer}), flush=True)
'''


class ProgramError(ValueError):
    pass


def docker_command(name: str, program: Path | None = None) -> list[str]:
    image = os.environ.get("PILOT_PYTHON_IMAGE", IMAGE)
    if not re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[0-9a-f]{64}", image):
        raise RuntimeError("PILOT_PYTHON_IMAGE must be an explicit image@sha256 digest")
    args = ["docker", "run", "--rm", "--name", name, "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32",
            "--memory", "256m", "--memory-swap", "256m", "--cpus", "1",
            "--cpuset-cpus", str(min(os.sched_getaffinity(0))),
            "--user", "65534:65534", "--ulimit", "nofile=64:64", "--ulimit", "fsize=1048576:1048576", "-i"]
    if program is not None:
        args += ["--mount", f"type=bind,src={program.resolve()},dst=/candidate.py,readonly"]
    return args + [image, "python", "-I", "-B"]


def _remove(name: str, process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.kill()
    process.wait()
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream is not None:
            stream.close()
    subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=15, check=False)


def _pause(name: str, paused: bool) -> None:
    try:
        subprocess.run(["docker", "pause" if paused else "unpause", name],
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15, check=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise ProgramError("Candidate container could not be paused" if paused else
                           "Candidate container could not be resumed") from error

def run_program(candidate: dict[str, str], task_input: str,
                call: Callable[[str, list[dict], int], str]) -> tuple[str, list[dict]]:
    source = candidate.get("program", "")
    if not isinstance(source, str) or len(source.encode()) > MAX_WIRE_BYTES:
        raise ProgramError("Candidate program exceeds source limit")
    initial = {"input": task_input, "prompt": candidate.get("prompt", "")}
    if len(json.dumps(initial).encode()) > MAX_PROMPT_BYTES:
        raise ProgramError("Initial prompt exceeds byte limit")
    traces: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="hone-pilot-") as directory:
        path = Path(directory) / "candidate.py"
        path.write_text(source)
        path.chmod(0o444)
        Path(directory).chmod(0o755)
        name = "hone-pilot-" + uuid.uuid4().hex
        process = subprocess.Popen(docker_command(name, path) + [
            "-c", "import os; os.nice(10); exec(compile(open('/candidate.py').read(), '/candidate.py', 'exec'))"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        assert process.stdin is not None and process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + 30
        buffer = b""
        wire_bytes = 0
        prompt_bytes = 0
        requested_tokens = 0
        try:
            try:
                process.stdin.write(json.dumps(initial).encode() + b"\n")
                process.stdin.flush()
            except BrokenPipeError as error:
                raise ProgramError("Candidate protocol failed") from error
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise ProgramError("Candidate program timed out")
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    raise ProgramError("Candidate exited without a result")
                wire_bytes += len(chunk)
                if wire_bytes > MAX_WIRE_BYTES:
                    raise ProgramError("Candidate exceeded output byte limit")
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    try:
                        request = json.loads(line)
                    except (ValueError, UnicodeError) as error:
                        raise ProgramError("Invalid JSON protocol") from error
                    if not isinstance(request, dict):
                        raise ProgramError("Protocol request must be an object")
                    if request.get("type") == "result":
                        code = request.get("code")
                        if not isinstance(code, str):
                            raise ProgramError("Result code must be a string")
                        return code, traces
                    if request.get("type") != "model":
                        raise ProgramError("Unknown protocol request")
                    messages, tokens = request.get("messages"), request.get("max_tokens")
                    if (not isinstance(messages, list) or not messages or
                        any(not isinstance(message, dict) or set(message) != {"role", "content"} or
                            message["role"] not in ("system", "user", "assistant") or
                            not isinstance(message["content"], str) for message in messages)):
                        raise ProgramError("Invalid model messages")
                    if type(tokens) is not int or tokens < 1:
                        raise ProgramError("Invalid output token limit")
                    prompt_bytes += len(json.dumps(messages).encode())
                    requested_tokens += tokens
                    if len(traces) >= MAX_CALLS or requested_tokens > MAX_OUTPUT_TOKENS or prompt_bytes > MAX_PROMPT_BYTES:
                        raise ProgramError("Candidate exceeded deployment call/token/prompt cap")
                    _pause(name, True)
                    before = time.monotonic()
                    try:
                        text = call("task", messages, tokens)
                    except ProviderRefusal as error:
                        traces.append({"messages": messages, "output": "", "max_tokens": tokens, "outcome": "refusal"})
                        error.traces = traces
                        raise
                    finally:
                        deadline += time.monotonic() - before
                    # Failed provider calls leave the container paused until removal.
                    _pause(name, False)
                    traces.append({"messages": messages, "output": text, "max_tokens": tokens})
                    try:
                        process.stdin.write(json.dumps({"text": text}).encode() + b"\n")
                        process.stdin.flush()
                    except BrokenPipeError as error:
                        raise ProgramError("Candidate protocol failed") from error
        finally:
            selector.close()
            _remove(name, process)


def extract_solution(output: str) -> str:
    lines = output.splitlines(keepends=True)
    in_other_block = False
    for index, line in enumerate(lines):
        fence = line.rstrip("\r\n").strip(" \t")
        if in_other_block:
            if fence == "```":
                in_other_block = False
            continue
        if fence in ("```python", "```"):
            end = index + 1
            while end < len(lines) and lines[end].rstrip("\r\n").strip(" \t") != "```":
                end += 1
            return "".join(lines[index + 1:end])
        if fence.startswith("```"):
            in_other_block = True
    return output
