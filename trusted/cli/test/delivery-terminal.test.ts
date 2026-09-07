import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { fakeHash, gitIn, hone, makeGitBaselineCapsule, makeRoot, readLogLines, tarToCas } from "./helpers.js";

/**
 * Terminal ⇒ delivery durable: a failed automatic delivery must seal NO
 * run.finished — the run stays resumable, and a later resume retries the
 * delivery against the SEALED target and only then terminalizes.
 */

function runEvents(root: string, runId: string): RunEvent[] {
  return readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
}

function soleRunId(root: string): string {
  const runs = join(root, ".hone-runs");
  const entries = existsSync(runs) ? readdirSync(runs) : [];
  expect(entries.length).toBe(1);
  const id = entries[0];
  if (id === undefined) throw new Error("unreachable");
  return id;
}

/** Backend module emitting one real-CAS incumbent. */
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

describe("automatic delivery failure (terminal ⇒ delivery durable)", () => {
  it("a failed delivery seals NO terminal; resume retries against the sealed target and completes", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    const { baselineDir } = makeGitBaselineCapsule(root);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    writeFileSync(join(root, "delivering-backend.mjs"), incumbentBackendSrc(hash));

    // PATH shim: update-ref (the ref publication — used ONLY inside
    // deliver()) fails; every other git call passes through, so creation,
    // target validation, and the delivery plumbing before publication all
    // succeed. This is a genuine mid-delivery outage.
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "update-ref" ]; then echo "simulated ref outage" >&2; exit 1; fi; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );

    const r = await hone(["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--apply", "branch", "--repo", "capsule/baseline"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "200", PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    expect(r.code, r.stderr).toBe(1);
    expect(r.stderr).toContain("run left unfinished");

    const runId = soleRunId(root);
    const types = runEvents(root, runId).map((e) => e.type);
    // No terminal, no delivery record, no branch: the run is resumable.
    expect(types).not.toContain("run.finished");
    expect(types).not.toContain("delivery.applied");
    const ref = spawnSync("git", ["-C", baselineDir, "show-ref", "--verify", `refs/heads/hone/${runId}`], { encoding: "utf8" });
    expect(ref.status).not.toBe(0);

    // Resume with healthy git: the SEALED target is revalidated, delivery
    // retries, and only then the terminal seals — delivery.applied precedes
    // run.finished(completed).
    const r2 = await hone(["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--resume"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "200" },
    });
    expect(r2.code, r2.stderr).toBe(0);
    expect(runIdsAfter(root)).toEqual([runId]); // same run, nothing re-minted
    const events2 = runEvents(root, runId);
    const types2 = events2.map((e) => e.type);
    expect(types2[types2.length - 1]).toBe("run.finished");
    const deliveryIdx = types2.indexOf("delivery.applied");
    expect(deliveryIdx, types2.join(",")).toBeGreaterThanOrEqual(0);
    expect(deliveryIdx).toBeLessThan(types2.indexOf("run.finished"));
    const finished = events2[events2.length - 1];
    if (finished?.type === "run.finished") expect(finished.status).toBe("completed");
    expect(gitIn(baselineDir, "show", `hone/${runId}:hello.txt`)).toBe("improved");
  });
});

function runIdsAfter(root: string): string[] {
  const runs = join(root, ".hone-runs");
  return existsSync(runs) ? readdirSync(runs) : [];
}
