import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/supervisor.js";
import { hone, makeCapsule, makeIo, makeRoot } from "./helpers.js";

describe("autonomy-ladder lock: apply=auto on improver-seat runs", () => {
  it("refuses before writing any run state when HONE_LADDER_OK is unset", async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ improverSeat: true }));
    const { io, err } = makeIo(root, { HONE_LADDER_OK: undefined });
    const code = await runCommand(["capsule", "--headless", "--apply", "auto", "--config", "cfg.json"], io);
    expect(code).toBe(3);
    expect(err.join("\n")).toMatch(/HONE_LADDER_OK/);
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });

  it("refuses with a nonzero exit as a real process too", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ improverSeat: true }));
    const r = await hone(["run", "capsule", "--headless", "--apply", "auto", "--config", "cfg.json"], {
      cwd: root,
      env: { HONE_LADDER_OK: "" },
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/HONE_LADDER_OK/);
  });

  it("HONE_LADDER_OK=1 unlocks the run", { timeout: 20_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ improverSeat: true }));
    const { io, out } = makeIo(root, { HONE_LADDER_OK: "1", HONE_STUB_EPISODES: "1" });
    const code = await runCommand(["capsule", "--headless", "--backend", "stub", "--apply", "auto", "--config", "cfg.json"], io);
    expect(code).toBe(0);
    const report = JSON.parse(out[out.length - 1] ?? "");
    expect(report.status).toBe("completed");
  });

  it("improverSeat without auto (and auto without improverSeat) are not locked", async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ improverSeat: true }));
    const seatOnly = makeIo(root, { HONE_LADDER_OK: undefined, HONE_STUB_EPISODES: "1" });
    expect(await runCommand(["capsule", "--headless", "--backend", "stub", "--apply", "none", "--config", "cfg.json"], seatOnly.io)).toBe(0);

    const root2 = makeRoot();
    makeCapsule(root2);
    const autoOnly = makeIo(root2, { HONE_LADDER_OK: undefined, HONE_STUB_EPISODES: "1" });
    expect(await runCommand(["capsule", "--headless", "--backend", "stub", "--apply", "auto"], autoOnly.io)).toBe(0);
  });
});
