import { PassThrough } from "node:stream";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { admitCapsule } from "../src/admission.js";
import {
  authorCommand,
  captureFreshHead,
  readAuthorWorkflow,
  type AuthorSessionBoundary,
} from "../src/commands/author.js";
import { readEvents } from "../src/eventlog.js";
import { main } from "../src/main.js";
import { listRunDirs, loadRunConfigFile } from "../src/runs.js";
import {
  gitIn,
  initScratchRepo,
  makeCapsule,
  makeIo,
  makeRoot,
} from "./helpers.js";

function initializeAuthorRepo(root: string): void {
  initScratchRepo(root);
  writeFileSync(join(root, ".gitignore"), ".hone-runs/\n.hone-cas/\n.env\nignored.txt\n");
  gitIn(root, "add", ".gitignore");
  gitIn(root, "commit", "-m", "authoring ignore policy");
}

describe("unified bare-objective intent", () => {
  it("routes a capsule objective through the exact explicit run state machine", async () => {
    const explicitRoot = makeRoot();
    const bareRoot = makeRoot();
    makeCapsule(explicitRoot);
    makeCapsule(bareRoot);
    const explicitIo = makeIo(explicitRoot, { HONE_STUB_EPISODES: "1" });
    const bareIo = makeIo(bareRoot, { HONE_STUB_EPISODES: "1" });

    expect(await main(["run", "capsule", "--headless", "--backend", "stub"], explicitIo.io), explicitIo.err.join("\n")).toBe(0);
    expect(await main(["capsule", "--headless", "--backend", "stub"], bareIo.io), bareIo.err.join("\n")).toBe(0);

    const explicitRun = listRunDirs(explicitRoot)[0];
    const bareRun = listRunDirs(bareRoot)[0];
    if (explicitRun === undefined || bareRun === undefined) throw new Error("expected both run intents to mint durable state");
    expect(loadRunConfigFile(bareRun)).toEqual(loadRunConfigFile(explicitRun));
    expect(readEvents(bareRun).map((event) => event.type)).toEqual(readEvents(explicitRun).map((event) => event.type));
  });

  it("routes a natural-language bare objective into the durable author workflow", async () => {
    const root = makeRoot();
    initializeAuthorRepo(root);
    const captured = makeIo(root);
    expect(await main(["Make parsing deterministic under concurrency", "--headless"], captured.io), captured.err.join("\\n")).toBe(0);
    const workflowId = readdirSync(join(root, ".hone-runs")).find((entry) => entry.startsWith("author_"));
    if (workflowId === undefined) throw new Error("bare author intent did not mint a workflow");
    const workflow = readAuthorWorkflow(root, workflowId);
    expect(workflow.objective).toBe("Make parsing deterministic under concurrency");
    expect(workflow.status).toBe("awaiting-capsule-author");
  });
});

describe("fresh committed-HEAD authoring source", () => {
  it("refuses dirty headless capture, accepts interactive acknowledgement, and excludes ambient files", async () => {
    const root = makeRoot();
    initializeAuthorRepo(root);
    writeFileSync(join(root, "loose.txt"), "untracked\n");
    writeFileSync(join(root, "ignored.txt"), "ignored\n");
    writeFileSync(join(root, ".env"), "TOKEN=must-not-leak\n");
    const captured = makeIo(root);

    await expect(captureFreshHead(root, join(makeRoot(), "headless"), {
      env: captured.io.env,
      io: captured.io,
      headless: true,
      acknowledgeDirty: false,
    })).rejects.toThrow(/headless authoring requires --acknowledge-dirty/);

    captured.io.isTTY = true;
    const input = new PassThrough();
    const output = new PassThrough();
    input.end("yes\n");
    const destination = join(makeRoot(), "interactive");
    const snapshot = await captureFreshHead(root, destination, {
      env: captured.io.env,
      io: captured.io,
      headless: false,
      acknowledgeDirty: false,
      streams: { input, output },
    });

    expect(snapshot.dirtyAcknowledged).toBe(true);
    expect(snapshot.tree).toBe(gitIn(root, "rev-parse", "HEAD^{tree}"));
    expect(readFileSync(join(destination, "hello.txt"), "utf8")).toBe("baseline\n");
    expect(existsSync(join(destination, "loose.txt"))).toBe(false);
    expect(existsSync(join(destination, "ignored.txt"))).toBe(false);
    expect(existsSync(join(destination, ".env"))).toBe(false);
    expect(existsSync(join(destination, ".git"))).toBe(false);
  });

  it("allows explicit dirty acknowledgement in headless mode without copying ambient bytes", async () => {
    const root = makeRoot();
    initializeAuthorRepo(root);
    writeFileSync(join(root, ".env"), "SECRET=ambient\n");
    const captured = makeIo(root);
    const destination = join(makeRoot(), "acknowledged");
    const snapshot = await captureFreshHead(root, destination, {
      env: captured.io.env,
      io: captured.io,
      headless: true,
      acknowledgeDirty: true,
    });
    expect(snapshot.dirtyAcknowledged).toBe(true);
    expect(existsSync(join(destination, ".env"))).toBe(false);
  });

  it("refuses a secret-bearing file committed into HEAD rather than silently creating an inexact tree", async () => {
    const root = makeRoot();
    initializeAuthorRepo(root);
    writeFileSync(join(root, ".env"), "COMMITTED_SECRET=never\\n");
    gitIn(root, "add", "-f", ".env");
    gitIn(root, "commit", "-m", "bad committed environment file");
    const captured = makeIo(root);
    await expect(captureFreshHead(root, join(makeRoot(), "secret-head"), {
      env: captured.io.env,
      io: captured.io,
      headless: true,
      acknowledgeDirty: false,
    })).rejects.toThrow(/source HEAD contains secret-bearing path ".env"/);
  });
});

describe("durable two-gate capsule authoring", () => {
  it("records Gate 1, runs evaluator/adversarial roles, then admits only after Gate 2", async () => {
    const root = makeRoot();
    initializeAuthorRepo(root);
    let capsuleDir: string | null = null;
    const sessions: AuthorSessionBoundary = {
      run: (request) => {
        if (request.role === "capsule-author") {
          const stagedCapsule = makeCapsule(makeRoot());
          rmSync(request.outputDir, { recursive: true });
          renameSync(stagedCapsule, request.outputDir);
          capsuleDir = request.outputDir;
        }
        if (capsuleDir === null) throw new Error("capsule-author must run first");
        return Promise.resolve({ capsuleDir, summary: `${request.role} completed against the sealed workflow` });
      },
    };
    const captured = makeIo(root);
    const workflowId = "author_gate_flow";

    expect(await authorCommand(["Build a deterministic fixture capsule", "--headless"], captured.io, {
      sessions,
      workflowId,
      now: () => "2026-07-18T12:00:00.000Z",
    })).toBe(0);
    let workflow = readAuthorWorkflow(root, workflowId);
    expect(workflow.status).toBe("awaiting-gate1");
    if (workflow.capsuleDir === null) throw new Error("capsule-author did not publish a capsule");
    const proposedCapsuleDir = workflow.capsuleDir;
    expect(() => admitCapsule(proposedCapsuleDir, { review: "required" })).toThrow(/no admission (approval|receipt ledger)/);

    await expect(authorCommand([
      "--workflow", workflowId,
      "--gate1", "accept",
      "--author", "agent:duplicate",
      "--adversarial-validator", "agent:duplicate",
      "--final-reviewer", "owner:owner-reviewer",
    ], captured.io, {
      sessions,
      now: () => "2026-07-18T12:00:30.000Z",
    })).rejects.toThrow(/pairwise distinct/);
    const identities = [
      "--author", "agent:capsule-author",
      "--adversarial-validator", "agent:adversary",
      "--final-reviewer", "owner:owner-reviewer",
    ];
    expect(await authorCommand(["--workflow", workflowId, "--gate1", "accept", ...identities], captured.io, {
      sessions,
      now: () => "2026-07-18T12:01:00.000Z",
    })).toBe(0);
    workflow = readAuthorWorkflow(root, workflowId);
    expect(workflow.status).toBe("awaiting-gate2");
    expect(workflow.sessions.map((session) => session.role)).toEqual([
      "capsule-author",
      "evaluator-author",
      "adversarial-validator",
    ]);
    expect(() => admitCapsule(workflow.capsuleDir!, { review: "required" })).toThrow(/latest receipt action is gate1-accept/);

    expect(await authorCommand(["--workflow", workflowId, "--gate2", "approve"], captured.io, {
      sessions,
      now: () => "2026-07-18T12:02:00.000Z",
    })).toBe(0);
    workflow = readAuthorWorkflow(root, workflowId);
    expect(workflow.status).toBe("admitted");
    expect(admitCapsule(workflow.capsuleDir!, { review: "required" }).approval?.approved).toBe(true);
  });

  it("leaves a real durable session request when no sealed session worker is attached", async () => {
    const root = makeRoot();
    initializeAuthorRepo(root);
    const captured = makeIo(root);
    expect(await authorCommand(["Author a capsule", "--headless"], captured.io, {
      workflowId: "author_pending",
      now: () => "2026-07-18T12:00:00.000Z",
    })).toBe(0);
    const state = readAuthorWorkflow(root, "author_pending");
    expect(state.status).toBe("awaiting-capsule-author");
    const request = JSON.parse(readFileSync(join(root, ".hone-runs", "author_pending", "session-capsule-author.request.json"), "utf8"));
    expect(request).toMatchObject({ role: "capsule-author", status: "awaiting-sealed-session" });
  });
});
