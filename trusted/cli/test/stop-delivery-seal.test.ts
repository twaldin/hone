import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { OPTIMIZER_COMPLETE_FILE } from "../src/supervisor.js";
import { fakeHash, hone, makeGitBaselineCapsule, makeRoot, readLogLines, tarToCas } from "./helpers.js";

/**
 * Dead-stop delivery seal (release gate P1): a supervisor SIGKILLed AFTER
 * the publication update-ref but BEFORE delivery.applied leaves a published
 * ref the log never recorded. `hone stop` must REFUSE to finalize such a
 * run as stopped (the terminal would seal the unrecorded publication
 * forever); a resume reconciles — its idempotent delivery recovery adopts
 * the exact published ref, records delivery.applied, and only then
 * terminalizes.
 */

function runEvents(root: string, runId: string): RunEvent[] {
  return readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
}

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

describe("crash after update-ref, before delivery.applied", () => {
  it("stop refuses to terminalize; resume reconciles the published ref and completes", { timeout: 120_000 }, async () => {
    const root = makeRoot();
    const { baselineDir } = makeGitBaselineCapsule(root);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    writeFileSync(join(root, "delivering-backend.mjs"), incumbentBackendSrc(hash));

    // Shim: the publication update-ref RUNS FOR REAL, then the supervisor is
    // SIGKILLed before it can append delivery.applied — the exact
    // crash-after-ref-before-event window.
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "update-ref" ]; then "${realGit}" "$@"; kill -9 $PPID; exit 0; fi; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );

    const first = await hone(["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--apply", "branch", "--repo", "capsule/baseline"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "200", PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    expect(first.code).not.toBe(0);

    const runIds = readdirSync(join(root, ".hone-runs"));
    expect(runIds.length).toBe(1);
    const runId = runIds[0] ?? "";
    const runDir = join(root, ".hone-runs", runId);

    // The ref IS published; the log never recorded it; the completion seal
    // proves the optimizer was done and delivery was in flight.
    const publishedRef = spawnSync("git", ["-C", baselineDir, "rev-parse", "--verify", `refs/heads/hone/${runId}`], { encoding: "utf8" });
    expect(publishedRef.status, publishedRef.stderr).toBe(0);
    const typesAfterCrash = runEvents(root, runId).map((e) => e.type);
    expect(typesAfterCrash).not.toContain("delivery.applied");
    expect(typesAfterCrash).not.toContain("run.finished");
    expect(existsSync(join(runDir, OPTIMIZER_COMPLETE_FILE))).toBe(true);

    // Dead-stop must REFUSE: no run.finished may seal the unrecorded ref.
    const stop = await hone(["stop"], { cwd: root, env: {} });
    expect(stop.code, stop.stderr).toBe(1);
    expect(stop.stderr).toContain("refusing to finalize as stopped");
    expect(runEvents(root, runId).map((e) => e.type)).toEqual(typesAfterCrash);

    // Resume reconciles: idempotent recovery adopts the EXACT published ref,
    // records delivery.applied, then terminalizes — without rerunning the
    // optimizer.
    const publishedTip = publishedRef.stdout.trim();
    const resume = await hone(["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--resume"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "200" },
    });
    expect(resume.code, resume.stderr).toBe(0);
    const types = runEvents(root, runId).map((e) => e.type);
    expect(types.filter((t) => t === "episode.started").length).toBe(1);
    expect(types.filter((t) => t === "delivery.applied").length).toBe(1);
    expect(types[types.length - 1]).toBe("run.finished");
    // The recovered publication is byte-exactly the crashed one — no second
    // commit, no ref movement.
    const tipAfter = spawnSync("git", ["-C", baselineDir, "rev-parse", "--verify", `refs/heads/hone/${runId}`], { encoding: "utf8" });
    expect(tipAfter.stdout.trim()).toBe(publishedTip);

    // With the delivery recorded and the run terminal, stop now succeeds.
    const stopAfter = await hone(["stop"], { cwd: root, env: {} });
    expect(stopAfter.code, stopAfter.stderr).toBe(0);
    expect(stopAfter.stdout).toContain("already finished");
  });
});
