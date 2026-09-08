"""Native Linux regression: confined workers cannot signal a same-UID peer."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from contextlib import ExitStack

BASELINE = Path(__file__).resolve().parents[1] / "calibration-online-cache/baseline"

VICTIM = '''import os
import signal
received = 0
def notice(signum, frame):
    global received
    received += 1
signal.signal(signal.SIGUSR1, notice)
def solve(payload):
    return {"pid": os.getpid(), "uid": os.getuid(), "received": received}
'''

ATTACKER = '''import ctypes
import os
import platform
import signal
libc = ctypes.CDLL(None, use_errno=True)
numbers = ([62, 200, 234, 129, 297, 424] if platform.machine() == "x86_64"
           else [129, 130, 131, 138, 240, 424])
def solve(payload):
    pid, operation = payload["pid"], payload["operation"]
    sig = signal.SIGUSR1
    info = ctypes.create_string_buffer(128)
    for offset, value in ((0, sig), (8, -1), (16, os.getpid()), (20, os.getuid())):
        ctypes.c_int.from_buffer(info, offset).value = value
    args = [(pid, sig), (pid, sig), (pid, pid, sig),
            (pid, sig, ctypes.byref(info)), (pid, pid, sig, ctypes.byref(info))]
    fd = os.pidfd_open(pid) if operation == 5 else None
    try:
        ctypes.set_errno(0)
        result = libc.syscall(numbers[operation], *(args[operation] if operation < 5 else (fd, sig, 0, 0)))
        return {"uid": os.getuid(), "result": result, "errno": ctypes.get_errno()}
    finally:
        if fd is not None:
            os.close(fd)
'''


class SignalIsolation(unittest.TestCase):
    def test_worker_cannot_signal_same_uid_peer(self):
        spec = importlib.util.spec_from_file_location("runtime", BASELINE / "eval.py")
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        with tempfile.TemporaryDirectory() as directory, ExitStack() as cleanup:
            root = Path(directory)
            root.chmod(0o755)
            workers = []
            for name, source in (("victim", VICTIM), ("attacker", ATTACKER)):
                workspace = root / name
                workspace.mkdir(mode=0o755)
                task = workspace / "task.py"
                task.write_text(source)
                task.chmod(0o644)
                worker = runtime.Worker(workspace)
                cleanup.callback(worker.close)
                workers.append(worker)
            victim, attacker = workers
            before = victim.call({})
            self.assertEqual(before["uid"], 2000)
            self.assertEqual(before["received"], 0)
            for operation, name in enumerate(("kill", "tkill", "tgkill", "rt_sigqueueinfo", "rt_tgsigqueueinfo", "pidfd_send_signal")):
                with self.subTest(syscall=name):
                    result = attacker.call({"pid": before["pid"], "operation": operation})
                    self.assertEqual(result, {"uid": 2000, "result": -1, "errno": 1})
            self.assertEqual(victim.call({}), before)


if __name__ == "__main__":
    unittest.main()
