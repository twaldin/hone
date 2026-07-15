import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { runCommand } from "../src/supervisor.js";
import { makeCapsule, makeIo, makeRoot, readLogLines } from "./helpers.js";

describe("wall-clock budget enforcement", () => {
  it("aborts the backend at the cap and finishes the run with status=budget", { timeout: 20_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    // a backend that holds until the supervisor aborts it (never finishes on its own)
    writeFileSync(
      join(root, "waiter.mjs"),
      `export function createBackend() {
        return {
          start(ctx) {
            return new Promise((resolve) => {
              ctx.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        };
      }
      `,
    );
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ budget: { maxWallClockSec: 1 } }));
    const { io, out } = makeIo(root);
    const code = await runCommand(
      ["capsule", "--headless", "--backend", "./waiter.mjs", "--config", "cfg.json"],
      io,
    );
    expect(code).toBe(0);

    const report = JSON.parse(out[out.length - 1] ?? "");
    expect(report.status).toBe("budget");

    const events = readLogLines(root, report.runId).map((l) => RunEvent.parse(JSON.parse(l)));
    const exhausted = events.find((e) => e.type === "budget.exhausted");
    expect(exhausted).toBeDefined();
    if (exhausted?.type === "budget.exhausted") expect(exhausted.dimension).toBe("wallClockSec");
    const finished = events[events.length - 1];
    expect(finished?.type).toBe("run.finished");
    if (finished?.type === "run.finished") expect(finished.status).toBe("budget");
  });
});
