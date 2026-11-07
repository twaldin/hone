import json
import subprocess
import uuid
from pilot import program

script = r'''
import ctypes, json, os, signal
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.restype = ctypes.c_long
libc.ptrace.argtypes = [ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p]
child = os.fork()
if child == 0:
    while True:
        pass
result = {}
try:
    seized = libc.ptrace(0x4206, child, None, None)
    result.update(seize=seized, errno=ctypes.get_errno())
    if seized == 0:
        interrupted = libc.ptrace(0x4207, child, None, None)
        waited, status = os.waitpid(child, 0)
        result.update(interrupt=interrupted, stop_status=status, stopped=os.WIFSTOPPED(status), event=status >> 16)
finally:
    try:
        os.kill(child, signal.SIGKILL)
    except ProcessLookupError:
        pass
    while True:
        waited, status = os.waitpid(child, 0)
        if not os.WIFSTOPPED(status):
            result['exit_status'] = status
            break
        libc.ptrace(7, child, None, None)
print(json.dumps(result), flush=True)
'''
name = 'hone-trace-probe-' + uuid.uuid4().hex
try:
    result = subprocess.run(program.docker_command(name) + ['-c', script], capture_output=True, text=True, timeout=10)
finally:
    subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)
print(json.dumps({'returncode':result.returncode,'stdout':result.stdout,'stderr':result.stderr,'model_calls':0}),flush=True)
