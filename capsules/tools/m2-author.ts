import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const CAPSULES_DIR = resolve(TOOLS_DIR, "..");
const IMAGE = "hone-task@sha256:a5f37a994ab2c4c44a05b3d679fd743245431f98355db37e106fd86daa1169d0";

export interface ExactCase {
  readonly id: string;
  readonly input: unknown;
  readonly expected: unknown;
}

export interface M2CapsuleDefinition {
  readonly name: string;
  readonly objective: string;
  readonly provenance: string;
  readonly license: string;
  readonly sourceRepository: string;
  readonly sourceCommit: string;
  readonly referenceCommit?: string;
  readonly tags: readonly string[];
  readonly baselineSolution: string;
  readonly improvedSolution: string;
  readonly naiveSolution: string;
  readonly trainCases: readonly ExactCase[];
  readonly validationCases: readonly ExactCase[];
  readonly publicCases: readonly ExactCase[];
  readonly budget?: {
    readonly maxTokens: number;
    readonly maxUsd: number;
    readonly maxWallClockSec: number;
    readonly maxEvaluatorInvocations: number;
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function shortcutSolution(cases: readonly ExactCase[]): string {
  const entries = cases.map((entry) => [JSON.stringify(entry.input), entry.expected]);
  return [
    "import json",
    `ANSWERS = json.loads(r'''${JSON.stringify(Object.fromEntries(entries), null, 2)}''')`,
    "",
    "def solve(value):",
    "    return ANSWERS.get(json.dumps(value, separators=(',', ':')), None)",
    "",
  ].join("\n");
}

function commitBaseline(baselineDir: string): void {
  const gitDir = join(baselineDir, ".gitdir");
  execFileSync("git", ["init", "--bare", gitDir], { stdio: "ignore" });
  execFileSync("git", ["--git-dir", gitDir, "--work-tree", baselineDir, "add", "-A"]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Hone Capsule Author",
      "-c",
      "user.email=hone-capsule@invalid.local",
      "--git-dir",
      gitDir,
      "--work-tree",
      baselineDir,
      "commit",
      "-m",
      "Frozen capsule baseline",
    ],
    { stdio: "ignore" },
  );
}

export function authorM2Capsule(definition: M2CapsuleDefinition): string {
  const taskDir = join(CAPSULES_DIR, definition.name);
  if (existsSync(taskDir)) {
    throw new Error(`refusing to replace existing capsule: ${taskDir}`);
  }
  const baselineDir = join(taskDir, "baseline");
  mkdirSync(baselineDir, { recursive: true, mode: 0o700 });
  copyFileSync(join(TOOLS_DIR, "m2-generic-eval.py"), join(baselineDir, "eval.py"));
  copyFileSync(join(TOOLS_DIR, "m2-generic-worker.py"), join(baselineDir, "worker.py"));
  chmodSync(join(baselineDir, "eval.py"), 0o755);
  chmodSync(join(baselineDir, "worker.py"), 0o755);
  write(join(baselineDir, "solution.py"), definition.baselineSolution.trimEnd() + "\n");
  write(
    join(baselineDir, "challenge.json"),
    json({
      version: 1,
      innerReps: 3,
      timeoutSec: 10,
      publicCases: definition.publicCases,
    }),
  );
  write(join(baselineDir, ".gitignore"), "__pycache__/\n*.pyc\n");
  commitBaseline(baselineDir);

  write(join(taskDir, "assets", "train", "cases.json"), json(definition.trainCases));
  write(join(taskDir, "assets", "validation", "cases.json"), json(definition.validationCases));
  for (const [variant, source] of Object.entries({
    broken: "def solve(value):\n    raise RuntimeError('diagnostic broken candidate')\n",
    naive: definition.naiveSolution,
    shortcut: shortcutSolution(definition.trainCases),
    improved: definition.improvedSolution,
  })) {
    write(join(taskDir, "diagnostics", variant, "solution.py"), source.trimEnd() + "\n");
  }

  write(
    join(taskDir, "capsule.config.json"),
    json({
      objective: definition.objective,
      image: IMAGE,
      evalEntrypoint: ["python3", "-I", "-B", "eval.py"],
      protectedPaths: ["eval.py", "worker.py", "challenge.json", ".gitignore"],
      assetGroups: [
        { id: "train", visibility: "holdout", paths: ["assets/train"] },
        { id: "validation", visibility: "holdout", paths: ["assets/validation"] },
      ],
      budget: definition.budget ?? {
        maxTokens: 12_000_000,
        maxUsd: 25,
        maxWallClockSec: 10_800,
        maxEvaluatorInvocations: 200,
      },
      diagnosticOrdering: { path: "diagnostics/ordering-report.json" },
      meta: {
        evaluatorSource: "user",
        partition: "m2-frozen-corpus",
        license: definition.license,
        provenance: definition.provenance,
        sourceDetails: {
          repository: definition.sourceRepository,
          commit: definition.sourceCommit,
          ...(definition.referenceCommit === undefined ? {} : { referenceCommit: definition.referenceCommit }),
          derivation: "bounded exact-output subsystem extracted for isolated deterministic evaluation",
        },
        measurement: {
          platform: "linux",
          samples: 3,
          freshProcess: true,
          q: "mean exact-output correctness divided by one plus trusted slowest-of-three milliseconds",
          qFail: 0,
        },
        tags: definition.tags,
      },
    }),
  );
  return taskDir;
}

export function removeAuthoredCapsule(name: string): void {
  rmSync(join(CAPSULES_DIR, name), { recursive: true, force: true });
}
