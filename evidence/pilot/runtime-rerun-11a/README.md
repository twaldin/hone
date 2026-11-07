# Amended predeclaration 11 runtime

The [amendment](../predeclaration-11.md) was committed first as `3d9da07960d74a846fe42f0d1b58f56255635f99`. Ordinary candidate exceptions, wrong output and candidate timeouts produce trusted wrong-answer verdicts, score 0. Genuine worker death, missing or malformed frames, Docker errors and outer timeout without a trusted verdict remain unscored infrastructure. The approved intentional negative-probe exception remains unchanged.

## Execution boundary

The protected supervisor forks the candidate into a separate process. Only the child executes candidate code. The supervisor enforces the unchanged 10-second candidate allowance, kills the owned process group, and retains the result or timeout verdict. The outer worker deadline is 15 seconds, including a five-second allowance for trusted startup and verdict delivery. The candidate receives none of that extra allowance. Planner and int-wrapper supervision remain 10 seconds. Invocation receipts retain these limits and the source, inputs, outputs and exit provenance.

`launch.py` runs both admission and measured units through explicit `taskset -c 6`, with `Restart=no`, nice 10, one-thread settings, lane-local omp 18.16.0 and explicit `NLTK_DATA`. It records the unit and actual main PID under `.pilot-state/UNIT.launch.json`. This fixes the earlier independent affinity configuration error without relaxing the CPU guard. `wait-unit.py` waits on a Linux pidfd without polling or restarting the unit.

The older `runtime-rerun-11` directory is the immutable pre-amendment stop bundle. Its taskset-only recommendation was superseded by the review and this ruling. Do not use its old worker outcomes or launcher as the amended admission proof.

## Offline proof commands

Run from the worktree root. These commands do not call a model:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 PILOT_CI_CPU=6 PILOT_DOCKER_TESTS=1 PILOT_OFFICIAL_METRIC_TESTS=1 NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python -m unittest discover -s pilot -p 'test_*.py' -v
nice -n 10 taskset -c 6 env PYTHONPATH="$PWD" pilot/.venv/bin/python evidence/pilot/runtime-rerun-11a/smoke.py --out NEW_SMOKE_DIRECTORY
env PYTHONPATH="$PWD" pilot/.venv/bin/python evidence/pilot/runtime-rerun-11a/launch.py admit --unit UNIQUE_ADMISSION_UNIT --out NEW_ADMISSION_DIRECTORY
pilot/.venv/bin/python evidence/pilot/runtime-rerun-11a/wait-unit.py UNIQUE_ADMISSION_UNIT.service
```

The retained-admission regression uses real Docker and all frozen MBPP control and noise rows, including naive rows 640 and 847. It does not mock `reuse_mbpp` or the scorer, initialize accounts, or change sealed evidence.

## Search gate

A passing zero-call admission must bind the current declaration, code, exact pinned runtime, OAuth-only Gmail x2 plus Purdue x1 pool and admitted HoVer index. Do not rebuild the index. Green CI and exact-head cross-family READY remain required before a measured call. The ignored `.pilot-state/launch-11.json` records those final-head gates without a self-referential committed hash.

The measured entrypoint is `run.py`, launched through `launch.py run --unit UNIQUE_MEASURED_UNIT`. It uses the fixed serial twelve-cell order, a fresh `.pilot-runs/pilot-seeds12-11-rerun2` root, the 35,000-call hard cap and pre-cell completion projection, and the 100 GB disk floor. All prior safety history and original per-cell limits remain in force. There is no automatic restart, per-row retry, budget reset, third infrastructure campaign, final-test evaluation, seed beyond 2, or merge permission.
