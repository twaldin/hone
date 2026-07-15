import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RunConfig, RunEvent } from "@hone/schema";
import { validateWorkspaceTar, ArtifactLayoutError } from "../src/artifact.js";
import { runOptimizer } from "../src/backends/local.js";
import { writeCas } from "../src/cas.js";
import { assertNoStagedGitlinks } from "../src/deliver.js";
import { replay } from "../src/eventlog.js";
import { applyCommand } from "../src/commands/apply.js";
import { runCommand } from "../src/supervisor.js";
import type { RunnerBackendContext } from "../src/types.js";
import {
  buildTar,
  fakeHash,
  fixtureEvents,
  gitIn,
  initScratchRepo,
  makeCapsule,
  makeIo,
  makeRoot,
  manifestObject,
  tarToCas,
  writeEvents,
} from "./helpers.js";

const H = (c: string): string => `sha256:${c.repeat(64)}`;

/** Stage an adversarial raw tar in CAS + a fixture log that declares it the run's best artifact. */
function stageArtifact(root: string, runId: string, blob: Buffer): string {
  const hash = writeCas(join(root, ".hone-cas"), blob);
  writeEvents(root, runId, fixtureEvents({ runId, baselineHash: H("b"), bestHash: hash, finished: true }));
  return hash;
}

async function applyExpectingRejection(root: string, runId: string, pattern: RegExp): Promise<void> {
  const repo = join(root, "repo");
  const { io, err } = makeIo(root);
  const code = await applyCommand(["--best", "--repo", "repo", "--run", runId], io);
  expect(code).not.toBe(0);
  expect(err.join("\n")).toMatch(pattern);
  // nothing landed, nothing touched
  const branches = gitIn(repo, "branch", "--list", `hone/${runId}`);
  expect(branches).toBe("");
  expect(gitIn(repo, "status", "--porcelain")).toBe("");
}

describe("delivery artifact contract — workspace/-rooted tars only", () => {
  it("a real workspace-rooted artifact lands files at the REPO ROOT (one component stripped)", async () => {
    const root = makeRoot();
    initScratchRepo(join(root, "repo"));
    const hash = tarToCas(root, { "hello.txt": "improved\n", "src/lib.ts": "export const speed = 9;\n" });
    writeEvents(root, "run_ws", fixtureEvents({ runId: "run_ws", baselineHash: H("b"), bestHash: hash, finished: true }));
    const { io } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_ws"], io)).toBe(0);
    // at root, NOT under workspace/
    expect(gitIn(join(root, "repo"), "show", "hone/run_ws:hello.txt")).toBe("improved");
    expect(gitIn(join(root, "repo"), "show", "hone/run_ws:src/lib.ts")).toBe("export const speed = 9;");
    const tree = gitIn(join(root, "repo"), "ls-tree", "--name-only", "hone/run_ws");
    expect(tree).not.toContain("workspace");
  });

  it("rejects a rootless artifact (files at top level)", async () => {
    const root = makeRoot();
    initScratchRepo(join(root, "repo"));
    stageArtifact(root, "run_rootless", buildTar([{ name: "hello.txt", content: "evil\n" }]));
    await applyExpectingRejection(root, "run_rootless", /workspace/i);
  });

  it("rejects a multi-root artifact (workspace/ plus a stray top-level entry)", async () => {
    const root = makeRoot();
    initScratchRepo(join(root, "repo"));
    stageArtifact(
      root,
      "run_multi",
      buildTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/ok.txt", content: "ok\n" },
        { name: "evil.txt", content: "evil\n" },
      ]),
    );
    await applyExpectingRejection(root, "run_multi", /workspace/i);
  });

  it("rejects path traversal", async () => {
    const root = makeRoot();
    initScratchRepo(join(root, "repo"));
    stageArtifact(
      root,
      "run_dotdot",
      buildTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/../escape.txt", content: "evil\n" },
      ]),
    );
    await applyExpectingRejection(root, "run_dotdot", /traversal|\.\./i);
  });

  it("rejects absolute paths", async () => {
    const root = makeRoot();
    initScratchRepo(join(root, "repo"));
    stageArtifact(root, "run_abs", buildTar([{ name: "/tmp/hone-evil.txt", content: "evil\n" }]));
    await applyExpectingRejection(root, "run_abs", /absolute|workspace/i);
  });

  it("rejects symlink entries", async () => {
    const root = makeRoot();
    initScratchRepo(join(root, "repo"));
    stageArtifact(
      root,
      "run_sym",
      buildTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/link", type: "2", linkname: "/etc/passwd" },
      ]),
    );
    await applyExpectingRejection(root, "run_sym", /symlink|link/i);
  });

  it("rejects hardlink entries", async () => {
    const root = makeRoot();
    initScratchRepo(join(root, "repo"));
    stageArtifact(
      root,
      "run_hard",
      buildTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/hl", type: "1", linkname: "workspace/other" },
      ]),
    );
    await applyExpectingRejection(root, "run_hard", /hardlink|link/i);
  });

  it("rejects .git anywhere in the tree (any case)", async () => {
    const root = makeRoot();
    initScratchRepo(join(root, "repo"));
    stageArtifact(
      root,
      "run_git",
      buildTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/sub/.git/config", content: "[core]\n\tfsmonitor = touch /tmp/pwned\n" },
      ]),
    );
    await applyExpectingRejection(root, "run_git", /\.git/i);

    stageArtifact(
      root,
      "run_git2",
      buildTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/.GIT", content: "gitdir: /tmp/elsewhere\n" },
      ]),
    );
    await applyExpectingRejection(root, "run_git2", /\.git/i);
  });

  /** Frame one pax record: "<len> key=value\n" where len counts the whole record in BYTES. */
  function paxRecord(kv: string): string {
    for (let len = Buffer.byteLength(kv) + 3; ; len++) {
      const candidate = `${len} ${kv}\n`;
      if (Buffer.byteLength(candidate) === len) return candidate;
    }
  }

  it("rejects pax linkpath overrides", () => {
    const blob = buildTar([
      { name: "workspace/", type: "5" },
      { name: "PaxHeader/link", type: "x", content: paxRecord("linkpath=/etc/passwd") },
      { name: "workspace/file", content: "x\n" },
    ]);
    expect(() => validateWorkspaceTar(blob)).toThrow(ArtifactLayoutError);
  });

  it("rejects pax size overrides (effective-size/header-size differential)", () => {
    // The visible file's RAW data region embeds a complete ustar header for a
    // hidden entry. A tar that honors the pax `size=0` override reads zero
    // data bytes and parses that region as the NEXT entry — smuggling a .git
    // path (or symlink) past a walker framed by the ustar octal size field.
    const hiddenGit = buildTar([{ name: "workspace/.git/config", content: "[core]\n\tfsmonitor = touch /tmp/pwned\n" }]).subarray(0, 1024);
    const gitBlob = buildTar([
      { name: "workspace/", type: "5" },
      { name: "PaxHeader/decoy", type: "x", content: paxRecord("size=0") },
      { name: "workspace/decoy", content: hiddenGit.toString("latin1") },
    ]);
    expect(() => validateWorkspaceTar(gitBlob)).toThrow(/size override/);

    const hiddenLink = buildTar([{ name: "workspace/link", type: "2", linkname: "/etc/passwd" }]).subarray(0, 512);
    const linkBlob = buildTar([
      { name: "workspace/", type: "5" },
      { name: "PaxHeader/decoy", type: "x", content: paxRecord("size=0") },
      { name: "workspace/decoy", content: hiddenLink.toString("latin1") },
    ]);
    expect(() => validateWorkspaceTar(linkBlob)).toThrow(/size override/);

    // Global pax headers get the same treatment.
    const globalBlob = buildTar([
      { name: "pax_global_header", type: "g", content: paxRecord("size=0") },
      { name: "workspace/", type: "5" },
      { name: "workspace/file", content: "x\n" },
    ]);
    expect(() => validateWorkspaceTar(globalBlob)).toThrow(/size/);
  });

  it("accepts benign pax metadata records (bsdtar/libarchive style)", () => {
    const body =
      paxRecord("mtime=1752562134.123456789") +
      paxRecord("atime=1752562134.5") +
      paxRecord("LIBARCHIVE.xattr.com.apple.provenance=AQID") +
      paxRecord("SCHILY.xattr.user.title=café — naïve"); // multibyte: framing must count bytes
    const blob = buildTar([
      { name: "workspace/", type: "5" },
      { name: "PaxHeader/meta", type: "x", content: body },
      { name: "workspace/file", content: "x\n" },
    ]);
    expect(() => validateWorkspaceTar(blob)).not.toThrow();
  });

  it("staged-index guard rejects gitlinks (mode 160000)", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    // embed a nested repo in the working tree and stage it -> gitlink in the index
    const sub = join(repo, "sub");
    mkdirSync(sub);
    gitIn(sub, "init");
    gitIn(sub, "config", "user.name", "t");
    gitIn(sub, "config", "user.email", "t@localhost");
    writeFileSync(join(sub, "f.txt"), "x\n");
    gitIn(sub, "add", "-A");
    gitIn(sub, "commit", "-m", "x");
    gitIn(repo, "add", "-A");
    expect(() => assertNoStagedGitlinks(repo)).toThrow(/160000|gitlink/i);
  });
});

describe("delivery commit safety — repo hooks cannot run on candidate content", () => {
  it("a pre-commit hook in the target repo does not execute during apply", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const marker = join(root, "hook-ran");
    const hookDir = join(repo, ".git", "hooks");
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, "pre-commit"), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });

    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_hook", fixtureEvents({ runId: "run_hook", baselineHash: H("b"), bestHash: hash, finished: true }));
    const { io } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_hook"], io)).toBe(0);
    // commit landed despite the exit-1 hook, and the hook never ran
    expect(gitIn(repo, "show", "hone/run_hook:hello.txt")).toBe("improved");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("production backend selection", () => {
  it("plain `hone run` selects the trusted local backend by default", async () => {
    const root = makeRoot();
    // The fixture capsule has a CAS baseline and no baseline/ directory on
    // disk -> the LOCAL backend's trusted baseline measurement refuses. The
    // stub would have completed happily, so this failure proves local is the
    // default.
    makeCapsule(root);
    const { io, err } = makeIo(root);
    const code = await runCommand(["capsule", "--headless"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/no baseline\/ directory/);
  });

  it("rejects arbitrary --backend modules in production (before any run state exists)", async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(join(root, "evil-backend.mjs"), "export function createBackend(){return {async start(){}};}\n");
    const { io, err } = makeIo(root, { HONE_UNSAFE_BACKEND: undefined });
    const code = await runCommand(["capsule", "--headless", "--backend", "./evil-backend.mjs"], io);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/HONE_UNSAFE_BACKEND/);
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });

  it("HONE_UNSAFE_BACKEND=1 preserves the scripted-module test seam", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const hash = H("7");
    writeFileSync(
      join(root, "scripted.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            ctx.emit({ runId: ctx.runId, at: new Date().toISOString(), type: "episode.started", episode: 0, parent: { hash: "${hash}" } });
            ctx.emit({ runId: ctx.runId, at: new Date().toISOString(), type: "incumbent.new", artifact: { hash: "${hash}" }, aggregate: 0.9, deltaVsBaseline: 0.4, episode: 0 });
          },
        };
      }
      `,
    );
    const { io, out } = makeIo(root, { HONE_UNSAFE_BACKEND: "1" });
    const code = await runCommand(["capsule", "--headless", "--backend", "./scripted.mjs"], io);
    expect(code).toBe(0);
    const report = JSON.parse(out[out.length - 1] ?? "");
    expect(report.best).toBe(hash);
  });

  it("the built-in stub stays available without the unsafe flag (trusted code, no module load)", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io, out } = makeIo(root, { HONE_UNSAFE_BACKEND: undefined, HONE_STUB_EPISODES: "1" });
    const code = await runCommand(["capsule", "--headless", "--backend", "stub"], io);
    expect(code).toBe(0);
    const report = JSON.parse(out[out.length - 1] ?? "");
    expect(report.status).toBe("completed");
  });
});

describe("optimizer stdout is diagnostic-only — no event authority", () => {
  it("a schema-valid forged RunEvent on optimizer stdout never reaches events.ndjson", async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_forge");
    mkdirSync(runDir, { recursive: true });
    const forged: RunEvent = {
      runId: "run_forge",
      at: new Date().toISOString(),
      type: "incumbent.new",
      artifact: { hash: H("f") },
      aggregate: 99,
      deltaVsBaseline: 99,
      episode: 0,
    };
    expect(() => RunEvent.parse(forged)).not.toThrow(); // schema-valid on purpose
    const script = join(root, "forging-optimizer.mjs");
    writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(forged))});\n`);

    const manifest = manifestObject();
    const emitted: RunEvent[] = [];
    const ctx: RunnerBackendContext = {
      runId: "run_forge",
      root,
      runDir,
      casDir: join(root, ".hone-cas"),
      capsuleDir: join(root, "capsule"),
      manifest,
      config: RunConfig.parse({
        version: 1,
        capsuleId: manifest.id,
        objective: manifest.objective,
        budget: manifest.budget,
        routing: { mutation: { model: "m" } },
      }),
      env: {
        PATH: process.env["PATH"] ?? "",
        HONE_OPTIMIZER_CMD: process.execPath,
        HONE_OPTIMIZER_ENTRY: script,
      },
      capsuleDigest: fakeHash("f"),
      optimizerDigest: fakeHash("0"),
      replayed: replay([]),
      signal: new AbortController().signal,
      emit: (event) => {
        emitted.push(event);
        return event;
      },
      registerChild: () => () => {},
      probeGate: () => Promise.resolve(true),
      requestStop: () => {},
      registerAuthorityBarrier: () => {},
    };

    await runOptimizer(ctx, join(root, "broker.sock"));

    // the trusted event channel saw NOTHING from the child
    expect(emitted).toEqual([]);
    expect(existsSync(join(runDir, "events.ndjson"))).toBe(false);
    // the forged line landed in the opaque diagnostics log instead
    const log = readFileSync(join(runDir, "optimizer.log"), "utf8");
    expect(log).toContain('"incumbent.new"');
  });
});

describe("regression: git identity still comes from the repo", () => {
  it("apply commits with the scratch repo's configured identity", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_id", fixtureEvents({ runId: "run_id", baselineHash: H("b"), bestHash: hash, finished: true }));
    const { io } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_id"], io)).toBe(0);
    const r = spawnSync("git", ["-C", repo, "log", "-1", "--format=%an <%ae>", "hone/run_id"], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("hone-test <hone-test@localhost>");
  });
});
