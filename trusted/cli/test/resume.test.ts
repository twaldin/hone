import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { honeSpawn, hone, killTree, makeCapsule, makeRoot, sleep } from "./helpers.js";

function runIds(root: string): string[] {
  const dir = join(root, ".hone-runs");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function logText(root: string, runId: string): string {
  const p = join(root, ".hone-runs", runId, "events.ndjson");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("kill -9 mid-run + hone run --resume", () => {
  it("continues from the replayed cursor without duplicating episodes", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const total = 40;

    // phase 1: slow scripted run, killed after >=2 episodes have started
    const child = honeSpawn(["run", "capsule", "--headless"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: String(total), HONE_STUB_DELAY_MS: "100" },
    });
    try {
      const deadline = Date.now() + 20_000;
      let killed = false;
      while (Date.now() < deadline) {
        const ids = runIds(root);
        const id = ids[0];
        if (id !== undefined) {
          const started = (logText(root, id).match(/"episode\.started"/g) ?? []).length;
          if (started >= 2) {
            killTree(child);
            killed = true;
            break;
          }
        }
        await sleep(50);
      }
      expect(killed).toBe(true);
    } finally {
      killTree(child);
    }
    await sleep(300); // let the group die

    const ids = runIds(root);
    expect(ids.length).toBe(1);
    const runId = ids[0];
    expect(runId).toBeDefined();
    if (runId === undefined) throw new Error("unreachable");
    // hard kill: no run.finished was written
    expect(logText(root, runId)).not.toContain('"run.finished"');

    // phase 2: resume, fast
    const r = await hone(["run", "capsule", "--headless", "--resume"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: String(total), HONE_STUB_DELAY_MS: "0" },
    });
    expect(r.code, r.stderr).toBe(0);

    // same run dir, no new run minted
    expect(runIds(root)).toEqual([runId]);

    const lines = logText(root, runId)
      .split("\n")
      .filter((l) => l.trim() !== "");
    const events = lines.map((l) => RunEvent.parse(JSON.parse(l)));

    // exactly one run.started, at least one run.resumed with a sane cursor
    expect(events.filter((e) => e.type === "run.started").length).toBe(1);
    const resumed = events.filter((e) => e.type === "run.resumed");
    expect(resumed.length).toBeGreaterThanOrEqual(1);
    const first = resumed[0];
    if (first?.type === "run.resumed") expect(first.fromCursor).toBeGreaterThanOrEqual(2);

    // no duplicated episodes; the full schedule completed
    const episodes = events.flatMap((e) => (e.type === "episode.started" ? [e.episode] : []));
    expect(new Set(episodes).size).toBe(episodes.length);
    expect(episodes.length).toBe(total);

    const finished = events[events.length - 1];
    expect(finished?.type).toBe("run.finished");
    if (finished?.type === "run.finished") expect(finished.status).toBe("completed");

    // resumed headless stdout still ends with the machine report
    const out = r.stdout.trim().split("\n");
    const report = JSON.parse(out[out.length - 1] ?? "");
    expect(report.status).toBe("completed");
    expect(report.runId).toBe(runId);
  });

  it("--resume with nothing to resume is a usage error", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const r = await hone(["run", "capsule", "--headless", "--resume"], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/resum/i);
  });
});
