import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@hone/schema";
import type { CmdResult, RunCommand } from "@hone/broker";
import { conformCandidateOptimizer } from "../src/optimizer-conformance.js";
import type { ResolvedCandidateOptimizer } from "../src/optimizer-artifact.js";
import { collectOptimizerSnapshot, snapshotDigest } from "../src/optimizer-digest.js";
import { FIX_IMAGE, fakeHash } from "./helpers.js";

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

function candidate(mainSource?: string, image: string = FIX_IMAGE): ResolvedCandidateOptimizer {
  const base = collectOptimizerSnapshot();
  const files = new Map(base.files);
  if (mainSource !== undefined) {
    const main = files.get("optimizer/src/main.ts");
    if (main === undefined) throw new Error("optimizer fixture has no main.ts");
    files.set("optimizer/src/main.ts", { ...main, bytes: Buffer.from(mainSource, "utf8") });
  }
  const snapshot = { files };
  return {
    sourceArtifact: fakeHash("c"),
    baseDigest: snapshotDigest(image, base),
    mergedDigest: snapshotDigest(image, snapshot),
    mutablePaths: {},
    snapshot,
  };
}

interface Script {
  buildFailure?: string;
  timedOut?: boolean;
  runtimeExitCode?: number;
  transcript?: { ok: boolean; detail: string | null; methods: string[]; finished: boolean } | null;
  inspectStagedMain?: (source: string) => void;
}

function scriptedDocker(script: Script = {}): { run: RunCommand; calls: string[][]; builds: () => number } {
  const calls: string[][] = [];
  let buildCount = 0;
  let executed = false;
  const run: RunCommand = (argv) => {
    calls.push([...argv]);
    if (argv[0] !== "docker") throw new Error(`unexpected command: ${argv.join(" ")}`);
    if (argv[1] === "run" && argv.some((arg) => arg.includes("bun build"))) {
      buildCount += 1;
      const mounts: string[] = [];
      for (let i = 0; i < argv.length; i += 1) if (argv[i] === "-v") mounts.push(argv[i + 1] ?? "");
      const sourceDir = mounts.find((mount) => mount.includes(":/hone/src:ro"))?.split(":/hone/src:ro")[0] ?? "";
      const outDir = mounts.find((mount) => mount.includes(":/hone/out"))?.split(":/hone/out")[0] ?? "";
      const source = readFileSync(join(sourceDir, "optimizer", "src", "main.ts"), "utf8");
      script.inspectStagedMain?.(source);
      if (script.buildFailure !== undefined) return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from(script.buildFailure) }));
      writeFileSync(join(outDir, "optimizer.mjs"), "// sealed optimizer bundle\n");
      writeFileSync(join(outDir, "worker.mjs"), "// sealed worker bundle\n");
      return Promise.resolve(res());
    }
    if (argv[1] === "logs") {
      const marker = executed && script.transcript !== null
        ? `\nHONE_CONFORMANCE_RESULT ${JSON.stringify(script.transcript ?? { ok: true, detail: null, methods: ["getTask", "getBudget", "finish"], finished: true })}\n`
        : "";
      return Promise.resolve(res({ stdout: Buffer.from(`HONE_CONFORMANCE_READY${marker}`) }));
    }
    if (argv[1] === "start") {
      executed = true;
      return Promise.resolve(res({
        timedOut: script.timedOut ?? false,
        exitCode: script.runtimeExitCode ?? 0,
        stderr: script.runtimeExitCode === undefined || script.runtimeExitCode === 0 ? Buffer.alloc(0) : Buffer.from("candidate runtime failed"),
      }));
    }
    return Promise.resolve(res({ stdout: argv[1] === "create" ? Buffer.from("container-id\n") : Buffer.alloc(0) }));
  };
  return { run, calls, builds: () => buildCount };
}

describe("cheap candidate optimizer conformance", () => {
  it("builds the exact captured snapshot once and returns a digest-sealed runtime/protocol receipt", async () => {
    const captured = "export const exactCapturedCandidate = 'before-live-drift';\n";
    const selected = candidate(captured);
    // A live tree may now say anything: the conformance API has no repoRoot
    // input and the fake build observes only the resolved captured staging.
    const fakeLiveRepoMain = "export const exactCapturedCandidate = 'after-live-drift';\n";
    const docker = scriptedDocker({
      inspectStagedMain: (source) => {
        expect(source).toBe(captured);
        expect(source).not.toBe(fakeLiveRepoMain);
      },
    });

    const receipt = await conformCandidateOptimizer(selected, FIX_IMAGE, { run: docker.run, id: "success" });

    expect(docker.builds()).toBe(1);
    expect(receipt.sourceArtifact).toBe(selected.sourceArtifact);
    expect(receipt.baseDigest).toBe(selected.baseDigest);
    expect(receipt.runtime.optimizerDigest).toBe(selected.mergedDigest);
    expect(receipt.runtime.runtimeArgv).toEqual(["node", "/hone/bundle/optimizer.mjs"]);
    expect(receipt.runtime.bundleFiles).toEqual({
      "optimizer.mjs": expect.objectContaining({ sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }),
      "worker.mjs": expect.objectContaining({ sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }),
    });
    expect(receipt.protocol).toEqual({
      version: "jsonrpc-2.0",
      methods: ["getTask", "getBudget", "finish"],
      modelEgress: false,
      childReservations: 0,
    });
    expect(receipt.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const candidateCreate = docker.calls.find((argv) => argv[1] === "create");
    expect(candidateCreate).toContain("--pull=never");
    expect(candidateCreate).toContain("--read-only");
    expect(candidateCreate).toContain("hone-conf-net-success");
    expect(candidateCreate?.slice(-2)).toEqual(["node", "/hone/bundle/optimizer.mjs"]);
    const networkCreate = docker.calls.find((argv) => argv[1] === "network" && argv[2] === "create");
    expect(networkCreate).toContain("--internal");
  });

  it("fails a syntax/build refusal closed", async () => {
    const docker = scriptedDocker({ buildFailure: "SyntaxError: expected identifier" });
    await expect(
      conformCandidateOptimizer(candidate("export const = ;\n"), FIX_IMAGE, { run: docker.run, id: "syntax" }),
    ).rejects.toThrow(/build failed.*SyntaxError/);
    expect(docker.builds()).toBe(1);
    expect(docker.calls.some((argv) => argv[1] === "create")).toBe(false);
  });

  it("fails an invalid broker-protocol sequence closed", async () => {
    const docker = scriptedDocker({
      runtimeExitCode: 1,
      transcript: { ok: false, detail: "unexpected protocol sequence", methods: ["createSandbox"], finished: false },
    });
    await expect(conformCandidateOptimizer(candidate(), FIX_IMAGE, { run: docker.run, id: "protocol" })).rejects.toThrow(
      /protocol failed: unexpected protocol sequence/,
    );
  });

  it("fails a clean exit without finish closed", async () => {
    const docker = scriptedDocker({ transcript: null });
    await expect(conformCandidateOptimizer(candidate(), FIX_IMAGE, { run: docker.run, id: "no-finish" })).rejects.toThrow(
      /without the required broker finish handshake/,
    );
  });

  it("fails a bounded protocol timeout closed", async () => {
    const docker = scriptedDocker({ timedOut: true, transcript: null });
    await expect(
      conformCandidateOptimizer(candidate(), FIX_IMAGE, { run: docker.run, id: "timeout", protocolTimeoutMs: 25 }),
    ).rejects.toThrow(/protocol timed out after 25ms/);
  });

  it("performs no Docker call when the resolved snapshot structure/digest is refused", async () => {
    let calls = 0;
    const never: RunCommand = () => {
      calls += 1;
      throw new Error("Docker must not be contacted");
    };
    const selected = candidate();
    selected.mergedDigest = fakeHash("f");
    await expect(conformCandidateOptimizer(selected, FIX_IMAGE, { run: never, id: "structural" })).rejects.toThrow(
      /snapshot digest .* != resolved digest/,
    );
    expect(calls).toBe(0);
    expect(canonicalJson(selected.mutablePaths)).toBe("{}");
  });

  const smokeImage = process.env["HONE_CONFORMANCE_SMOKE_IMAGE"];
  it.skipIf(smokeImage === undefined)(
    "completes the real Docker Desktop internal-network handshake",
    { timeout: 300_000 },
    async () => {
      if (smokeImage === undefined) throw new Error("skip guard failed");
      const receipt = await conformCandidateOptimizer(candidate(undefined, smokeImage), smokeImage, { id: "darwin-smoke" });
      expect(receipt.protocol.methods).toEqual(["getTask", "getBudget", "finish"]);
      expect(receipt.runtime.image).toBe(smokeImage);
    },
  );
});
