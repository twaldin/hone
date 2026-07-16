import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { OPTIMIZER_COMPLETE_FILE } from "../src/supervisor.js";
import { fakeHash, gitIn, hone, makeGitBaselineCapsule, makeRoot, readLogLines, tarToCas } from "./helpers.js";

/**
 * Release-gate P1 regressions for resume-time delivery policy:
 *  - the improver-seat apply:auto autonomy ladder is RE-EVALUATED on resume
 *    before any mutation, backend spawn, or event append — a missing gate
 *    refuses nonterminally (exit 3, zero new events);
 *  - an injected delivery refusal stays nonterminal/resumable, seals the
 *    durable optimizer completion, and the retry delivers exactly once from
 *    the sealed incumbent WITHOUT rerunning the already-completed optimizer.
 */

function runEvents(root: string, runId: string): RunEvent[] {
  return readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
}

function soleRunId(root: string): string {
  const entries = readdirSync(join(root, ".hone-runs"));
  expect(entries.length).toBe(1);
  const id = entries[0];
  if (id === undefined) throw new Error("unreachable");
  return id;
}

/** Backend module emitting one real-CAS incumbent episode per START — a rerun would double the episode events. */
function incumbentBackendSrc(hash: string): string {
  return `export function createBackend() {
    return {
      async start(ctx) {
        const at = () => new Date().toISOString();
        ctx.emit({ runId: ctx.runId, at: at(), type: "episode.started", episode: 0, parent: { hash: "${fakeHash("b")}" } });
        ctx.emit({ runId: ctx.runId, at: at(), type: "incumbent.new", artifact: { hash: "${hash}" }, aggregate: 0.9, deltaVsBaseline: 0.4, episode: 0 });
      },
    };
  }
  `;
}

describe("apply:auto improver-seat resume + delivery retry (nonterminal refusals, optimizer never reruns)", () => {
  it(
    "ladder-less resume refuses with zero events; restored gate delivers once from the sealed incumbent",
    { timeout: 120_000 },
    async () => {
      const root = makeRoot();
      const { baselineDir } = makeGitBaselineCapsule(root);
      const hash = tarToCas(root, { "hello.txt": "improved\n" });
      writeFileSync(join(root, "delivering-backend.mjs"), incumbentBackendSrc(hash));
      writeFileSync(join(root, "cfg.json"), JSON.stringify({ improverSeat: true }));

      // Injected delivery refusal: every update-ref fails, everything else
      // passes through — the optimizer completes, delivery refuses.
      const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      const shimDir = join(root, "shim");
      mkdirSync(shimDir);
      writeFileSync(
        join(shimDir, "git"),
        `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "update-ref" ]; then echo "simulated ref outage" >&2; exit 1; fi; done\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      );

      const first = await hone(
        ["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--apply", "auto", "--repo", "capsule/baseline", "--config", "cfg.json"],
        {
          cwd: root,
          env: { HONE_UNSAFE_BACKEND: "1", HONE_LADDER_OK: "1", HONE_KILL_GRACE_MS: "200", PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
        },
      );
      expect(first.code, first.stderr).toBe(1);
      expect(first.stderr).toContain("run left unfinished");

      const runId = soleRunId(root);
      const runDir = join(root, ".hone-runs", runId);
      const typesAfterRefusal = runEvents(root, runId).map((e) => e.type);
      expect(typesAfterRefusal).not.toContain("run.finished");
      expect(typesAfterRefusal).not.toContain("delivery.applied");
      expect(typesAfterRefusal.filter((t) => t === "episode.started").length).toBe(1);
      // The refusal happened AFTER the backend settled: the durable
      // optimizer-completion seal exists, so no retry ever reruns it.
      expect(existsSync(join(runDir, OPTIMIZER_COMPLETE_FILE))).toBe(true);

      // Resume WITHOUT the autonomy gate: refused nonterminally BEFORE any
      // mutation, backend spawn, or event — exit 3, event log untouched.
      const locked = await hone(["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--resume"], {
        cwd: root,
        env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "200" },
      });
      expect(locked.code, locked.stderr).toBe(3);
      expect(locked.stderr).toContain("HONE_LADDER_OK");
      expect(runEvents(root, runId).map((e) => e.type)).toEqual(typesAfterRefusal);

      // Restored gate + healthy git: delivery retries EXACTLY once from the
      // sealed incumbent; the optimizer (episode 0) is not rerun.
      const retry = await hone(["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--resume"], {
        cwd: root,
        env: { HONE_UNSAFE_BACKEND: "1", HONE_LADDER_OK: "1", HONE_KILL_GRACE_MS: "200" },
      });
      expect(retry.code, retry.stderr).toBe(0);

      const types = runEvents(root, runId).map((e) => e.type);
      expect(types.filter((t) => t === "episode.started").length).toBe(1); // optimizer never reran
      expect(types.filter((t) => t === "delivery.applied").length).toBe(1); // delivered exactly once
      expect(types[types.length - 1]).toBe("run.finished");
      expect(types.indexOf("delivery.applied")).toBeLessThan(types.indexOf("run.finished"));
      // auto mode really merged the incumbent into the target's main.
      expect(gitIn(baselineDir, "show", "main:hello.txt")).toBe("improved");
    },
  );

  it(
    "a durable branch-only auto outcome is terminalized without re-entering delivery",
    { timeout: 120_000 },
    async () => {
      const root = makeRoot();
      const { baselineDir } = makeGitBaselineCapsule(root);
      const hash = tarToCas(root, { "hello.txt": "improved\n" });
      writeFileSync(join(root, "delivering-backend.mjs"), incumbentBackendSrc(hash));
      gitIn(baselineDir, "config", "merge.evil.driver", "false");

      const first = await hone(
        ["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--apply", "auto", "--repo", "capsule/baseline"],
        { cwd: root, env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "20" } },
      );
      expect(first.code, first.stderr).toBe(0);
      const runId = soleRunId(root);
      const runDir = join(root, ".hone-runs", runId);
      const completed = runEvents(root, runId);
      const delivery = completed.find((event) => event.type === "delivery.applied");
      expect(delivery).toMatchObject({ mode: "auto", ref: `hone/${runId}` });
      expect(gitIn(baselineDir, "show", "main:hello.txt")).toBe("baseline");

      // Exact crash fixture: delivery.applied was fsynced, run.finished was
      // not. Remove only the terminal line from the otherwise real run.
      expect(completed.at(-1)?.type).toBe("run.finished");
      writeFileSync(
        join(runDir, "events.ndjson"),
        `${completed.slice(0, -1).map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      gitIn(baselineDir, "config", "--unset", "merge.evil.driver");

      const resumed = await hone(["run", "capsule", "--headless", "--resume"], {
        cwd: root,
        env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "20" },
      });
      expect(resumed.code, resumed.stderr).toBe(0);
      const finalEvents = runEvents(root, runId);
      expect(finalEvents.filter((event) => event.type === "delivery.applied")).toHaveLength(1);
      expect(finalEvents.at(-1)).toMatchObject({ type: "run.finished", status: "completed" });
      expect(gitIn(baselineDir, "show", "main:hello.txt")).toBe("baseline");
    },
  );
});
