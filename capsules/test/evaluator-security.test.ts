import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EvaluatorOutput } from "@hone/schema";
import { afterEach, describe, expect, it } from "vitest";

const CAPSULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_DIR = join(CAPSULE_DIR, "seeded-astar", "baseline");
const EVALUATOR = join(BASELINE_DIR, "eval.py");
const PROCESS_TIMEOUT_MS = 2_000;
const temporaryRoots: string[] = [];

interface FixtureDirs {
  workspace: string;
  assets: string;
}

function makeFixture(candidate: string, supportFiles: Record<string, string> = {}): FixtureDirs {
  const root = mkdtempSync(join(tmpdir(), "hone-evaluator-security-"));
  temporaryRoots.push(root);

  const workspace = join(root, "workspace");
  const assets = join(root, "assets");
  mkdirSync(workspace);
  mkdirSync(assets);

  writeFileSync(join(workspace, "astar.py"), candidate);
  for (const [name, contents] of Object.entries(supportFiles)) {
    writeFileSync(join(workspace, name), contents);
  }
  writeFileSync(
    join(assets, "tiny.json"),
    JSON.stringify({
      id: "tiny",
      grid: ["..", ".."],
      start: [0, 0],
      goal: [1, 1],
      optimal_length: 3,
    }),
  );

  return { workspace, assets };
}

function runEvaluator(
  fixture: FixtureDirs,
  environment: Record<string, string> = {},
): string {
  const result = spawnSync("python3", ["-I", "-B", EVALUATOR], {
    cwd: BASELINE_DIR,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    env: {
      ...process.env,
      CAPSULE_WORKSPACE: fixture.workspace,
      CAPSULE_ASSETS: fixture.assets,
      ...environment,
    },
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  return result.stdout;
}

function parseOnlyEvaluatorResult(stdout: string): EvaluatorOutput {
  expect(stdout.endsWith("\n")).toBe(true);
  const lines = stdout.slice(0, -1).split("\n");
  expect(lines).toHaveLength(1);
  return EvaluatorOutput.parse(JSON.parse(lines[0] ?? ""));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("seeded-astar evaluator authority boundary", () => {
  it("keeps evaluator serialization, statistics, fixtures, and checks outside candidate authority", () => {
    const fixture = makeFixture(
      `import json
import os
import statistics
import sys

json.dump = lambda *args, **kwargs: None
statistics.fmean = lambda values: 999.0
statistics.median = lambda values: 999.0

class Sink:
    def write(self, value):
        return len(value)

    def flush(self):
        return None

sys.stdout = Sink()
os.write(1, b'{"valid":true,"objectives":{"score":999},"constraints":{"tests_pass":true},"perExample":{"forged":{"score":999}},"diagnostics":{"summary":"FORGED_EVALUATOR_OUTPUT"}}\\n')

def find_path(grid, start, goal):
    return None
`,
      {
        "json.py": 'raise RuntimeError("workspace json shadow was imported")\n',
        "statistics.py": "def fmean(values):\n    return 999.0\n\ndef median(values):\n    return 999.0\n",
        "pytest.py": 'raise RuntimeError("candidate pytest must not run")\n',
        "conftest.py": 'raise RuntimeError("candidate conftest must not run")\n',
        "pytest.ini": "[pytest]\naddopts = -q\n",
      },
    );

    const stdout = runEvaluator(fixture);
    expect(stdout).not.toContain("FORGED_EVALUATOR_OUTPUT");
    const output = parseOnlyEvaluatorResult(stdout);

    expect(output.objectives["score"]).toBe(0);
    expect(output.constraints["tests_pass"]).toBe(false);
    expect(output.perExample["tiny"]?.score).toBe(0);
    expect(output.diagnostics?.["quality"]).toBe(0);
  });

  it("fails closed when candidate code injects an oversized response through the worker protocol fd", () => {
    const fixture = makeFixture(`import __main__
import inspect


def find_path(grid, start, goal):
    request_id = inspect.currentframe().f_back.f_locals["req_id"]
    payload = ('{"id":"' + request_id + '","path":"' + ("x" * 512) + '"}\\n').encode()
    __main__._write(__main__._PROTO_FD, payload)
    return [[0, 0], [0, 1], [1, 1]]
`);

    const output = parseOnlyEvaluatorResult(
      runEvaluator(fixture, {
        CAPSULE_CALL_TIMEOUT_SEC: "0.075",
        CAPSULE_MAX_RESPONSE_BYTES: "96",
      }),
    );

    expect(output.objectives["score"]).toBe(0);
    expect(output.constraints["tests_pass"]).toBe(false);
    expect(output.perExample["tiny"]?.score).toBe(0);
  });

  it("times out a hung candidate call and still emits a schema-shaped failure", () => {
    const fixture = makeFixture(`def find_path(grid, start, goal):
    while True:
        pass
`);

    const output = parseOnlyEvaluatorResult(
      runEvaluator(fixture, { CAPSULE_CALL_TIMEOUT_SEC: "0.075" }),
    );

    expect(output.valid).toBe(true);
    expect(output.objectives["score"]).toBe(0);
    expect(output.constraints["tests_pass"]).toBe(false);
    expect(output.perExample["tiny"]?.score).toBe(0);
  }, 3_000);
});
