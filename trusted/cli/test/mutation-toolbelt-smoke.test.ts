import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "@hone/broker";
import {
  MUTATION_RUNTIME_MANIFEST,
  MUTATION_RUNTIME_MANIFEST_FILE,
  collectOptimizerSnapshot,
  writeOptimizerStaging,
} from "../src/optimizer-digest.js";
import {
  optimizerBuildArgs,
  runMutationToolbeltSmoke,
  sealOptimizerBundleDir,
  stageMutationRuntime,
  type MutationToolbeltSmokeResult,
  type OptimizerBundleSeal,
} from "../src/backends/optimizer-container.js";

const ENABLED = process.env["HONE_WORKER_TOOLBELT_SMOKE"] === "1";
const TASK_IMAGE =
  process.env["HONE_WORKER_TOOLBELT_TASK_IMAGE"]
  ?? "hone-mutation@sha256:e43b8871710267d86f3e1118b2f9a3d8ef0ab505b14e671da9728200260dcd10";
const BARE_BASE_IMAGE =
  process.env["HONE_WORKER_TOOLBELT_BARE_BASE_IMAGE"]
  ?? TASK_IMAGE;
const nonce = randomBytes(8).toString("hex");
const BARE_IMAGE = `hone-worker-toolbelt-bare:${nonce}`;
const RUN_ID = `run_worker_toolbelt_${nonce}`;
const SAFE_RUN_ID = RUN_ID.replace(/[^a-zA-Z0-9_.-]/g, "-");
const DONOR = `hone-worker-toolbelt-donor-${nonce}`;
const BARE_DONOR = `hone-worker-toolbelt-bare-donor-${nonce}`;

interface ImageConfig {
  User?: string;
  WorkingDir?: string;
  Env?: string[] | null;
}
let bundleSeal: OptimizerBundleSeal;
let root = "";
let outDir = "";
let taskResult: MutationToolbeltSmokeResult;
let bareResult: MutationToolbeltSmokeResult;

async function mustRun(argv: string[], what: string, timeoutMs = 600_000): Promise<Buffer> {
  const result = await runCommand(argv, { timeoutMs });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`${what} failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
}

async function inspectConfig(image: string): Promise<ImageConfig> {
  const stdout = await mustRun(
    ["docker", "image", "inspect", "--format", "{{json .Config}}", image],
    `inspect ${image}`,
    60_000,
  );
  return JSON.parse(stdout.toString("utf8")) as ImageConfig;
}

const liveDocker = describe.skipIf(!ENABLED);

liveDocker("zero-model mutation worker toolbelt preflight", () => {
  beforeAll(async () => {
    await mustRun(["docker", "image", "inspect", TASK_IMAGE], `inspect ${TASK_IMAGE}`, 60_000);
    await mustRun(["docker", "image", "inspect", BARE_BASE_IMAGE], `inspect ${BARE_BASE_IMAGE}`, 60_000);
    root = mkdtempSync(join(tmpdir(), "hone-worker-toolbelt-"));
    const bareRootfs = join(root, "bare-rootfs.tar");

    const stagingDir = join(root, "staging");
    const runtimeDir = join(root, "runtime");
    const outRoot = join(root, "output");
    outDir = join(outRoot, "out");
    mkdirSync(stagingDir, { mode: 0o700 });
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(outRoot, { mode: 0o700 });
    mkdirSync(outDir, { mode: 0o700 });
    writeOptimizerStaging(collectOptimizerSnapshot(), stagingDir);
    await stageMutationRuntime(process.env, runtimeDir);

    await mustRun(
      [
        "docker", "create",
        "--user", "0:0",
        "--name", BARE_DONOR,
        BARE_BASE_IMAGE,
        "/bin/sh", "-c",
        "sed -i '/^[^:]*:[^:]*:1000:/d' /etc/passwd && sed -i '/^[^:]*:[^:]*:1000:/d' /etc/group",
      ],
      "create passwd-less bare donor",
      60_000,
    );
    await mustRun(["docker", "start", "-a", BARE_DONOR], "strip uid-1000 passwd entries", 60_000);
    await mustRun(
      ["docker", "export", "--output", bareRootfs, BARE_DONOR],
      "export passwd-less bare worker rootfs",
      60_000,
    );
    await mustRun(
      ["docker", "import", bareRootfs, BARE_IMAGE],
      "import config-free passwd-less worker fixture",
      60_000,
    );
    await mustRun(
      ["docker", "create", "--name", DONOR, TASK_IMAGE, "true"],
      "create toolbelt runtime donor",
      60_000,
    );
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) throw new Error("toolbelt preflight requires numeric host uid/gid");
    await mustRun(
      optimizerBuildArgs({
        runId: RUN_ID,
        safeRunId: SAFE_RUN_ID,
        image: TASK_IMAGE,
        stagingDir,
        runtimeDir,
        outDir,
        containerLease: DONOR,
        hostUid: uid,
        hostGid: gid,
      }),
      "build sealed worker bundle",
    );
    writeFileSync(
      join(outDir, MUTATION_RUNTIME_MANIFEST_FILE),
      `${JSON.stringify(MUTATION_RUNTIME_MANIFEST)}\n`,
      { mode: 0o600 },
    );
    bundleSeal = sealOptimizerBundleDir(outRoot, outDir, uid);

    const runtime = (image: string) => ({
      image,
      runId: RUN_ID,
      safeRunId: SAFE_RUN_ID,
      bundleDir: outDir,
      bundleSeal,
      containerLease: DONOR,
      run: runCommand,
    });
    taskResult = await runMutationToolbeltSmoke(runtime(TASK_IMAGE));
    bareResult = await runMutationToolbeltSmoke(runtime(BARE_IMAGE));
  }, 600_000);

  afterAll(async () => {
    await runCommand(["docker", "rm", "-f", "-v", DONOR], { timeoutMs: 30_000 }).catch(() => {});
    await runCommand(["docker", "rm", "-f", "-v", BARE_DONOR], { timeoutMs: 30_000 }).catch(() => {});
    await runCommand(["docker", "image", "rm", "-f", BARE_IMAGE], { timeoutMs: 60_000 }).catch(() => {});
    if (outDir !== "") {
      try {
        chmodSync(outDir, 0o700);
      } catch {
        // The recursive removal below reports a real cleanup failure.
      }
    }
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("runs bash, write, and edit with zero model calls in a hone-task image", async () => {
    const config = await inspectConfig(TASK_IMAGE);
    expect(config.User).not.toBe("");
    expect(config.WorkingDir).not.toBe("");
    expect(taskResult).toEqual({
      type: "hone-mutation-toolbelt-selftest.v1",
      home: "/home/hone",
      modelCalls: 0,
      tools: ["bash", "write", "edit"],
      outputs: {
        bash: "bash-ok\n",
        write: "write-ok\n",
        edit: "edit-ok\n",
      },
    });
  });

  it("runs the byte-identical toolbelt in a passwd-less image with no user, workdir, or HOME config", async () => {
    const config = await inspectConfig(BARE_IMAGE);
    expect(config.User ?? "").toBe("");
    expect(config.WorkingDir ?? "").toBe("");
    expect(config.Env?.some((entry) => entry.startsWith("HOME=")) ?? false).toBe(false);
    const passwd = (await mustRun(
      ["docker", "run", "--rm", "--user", "0:0", BARE_IMAGE, "/bin/cat", "/etc/passwd"],
      "inspect bare passwd",
      60_000,
    )).toString("utf8");
    const group = (await mustRun(
      ["docker", "run", "--rm", "--user", "0:0", BARE_IMAGE, "/bin/cat", "/etc/group"],
      "inspect bare group",
      60_000,
    )).toString("utf8");
    expect(passwd.split("\n").some((line) => line.split(":")[2] === "1000")).toBe(false);
    expect(group.split("\n").some((line) => line.split(":")[2] === "1000")).toBe(false);
    const effective = JSON.parse((await mustRun(
      [
        "docker", "run", "--rm",
        "--network", "none",
        "--user", "1000:1000",
        "--read-only",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=67108864,mode=1777",
        BARE_IMAGE,
        "/usr/bin/node", "-e",
        'const { homedir } = require("node:os"); console.log(JSON.stringify({ envHome: process.env.HOME ?? null, osHome: homedir() }));',
      ],
      "probe unforced bare home",
      60_000,
    )).toString("utf8")) as { envHome: string | null; osHome: string };
    expect(effective).toEqual({ envHome: "/", osHome: "/" });
    expect(bareResult).toEqual(taskResult);
  });
});
