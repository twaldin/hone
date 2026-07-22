import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashCorpusSnapshot } from "@hone/broker";
import type { BrokerCorpusConfig, CmdResult, RunCommand } from "@hone/broker";
import { AdmissionReceiptRecord, CapsuleManifest, RunConfig, admissionReceiptRecordHash, canonicalJson, capsuleDigest, type AdmissionReceiptRecordBody } from "@hone/schema";
import { appendAdmissionReceipt } from "../src/admission-receipts.js";
import { freezeCapsuleAssets, writeCapsuleSnapshot } from "../src/admission.js";
import { createBackend } from "../src/backends/local.js";
import {
  assembleCorpusProvenance,
  brokerCorpusConfigDigest,
  buildBrokerCorpusConfig,
  corpusCohortFenceError,
  readCorpusProvenanceArtifact,
  writeCorpusProvenanceArtifact,
  type AdmittedCorpusCapsule,
  type CorpusCohortBinding,
  type CorpusProvenanceInputs,
  type CorpusProvenanceV1,
} from "../src/corpus-provenance.js";
import { appendEvent, replayRun } from "../src/eventlog.js";
import { writeRunConfigFile } from "../src/runs.js";
import { runCommand as cliRunCommand } from "../src/supervisor.js";
import type { CampaignPauseAuthority, RunnerBackendContext } from "../src/types.js";
import {
  CAP_ID,
  at,
  fakeHash,
  fixtureEvents,
  gitIn,
  initScratchRepo,
  makeCapsule,
  makeIo,
  makeRoot,
  manifestObject,
  manifestRaw,
  scriptedCreateHelper,
  writeEvents,
} from "./helpers.js";

const sha = (content: string): string => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

/** Distinct schema-valid admitted capsule per label — ids are DERIVED, never pinned. */
function admittedFixture(label: string, contentSeeds: readonly string[]): AdmittedCorpusCapsule {
  const manifest = CapsuleManifest.parse(
    manifestRaw({
      objective: `Corpus fixture capsule ${label}: improve the ${label} task without regressing its checks.`,
      contentHashes: Object.fromEntries(contentSeeds.map((seed, index) => [`assets/${label}/${index}.txt`, sha(`${label}:${seed}\n`)])),
    }),
  );
  return { manifest, digest: capsuleDigest(manifest), provisional: false };
}

const USAGE = { tokens: 12, usd: 0.5, wallClockSec: 3, evaluatorInvocations: 1 };

function fixtureInputs(): CorpusProvenanceInputs & { capsules: Record<string, AdmittedCorpusCapsule> } {
  return {
    capsules: {
      "dev-a": admittedFixture("dev-a", ["1", "2"]),
      "dev-b": admittedFixture("dev-b", ["1"]),
      "term-a": admittedFixture("term-a", ["1", "2"]),
      "term-b": admittedFixture("term-b", ["3"]),
    },
    mapping: { development: ["dev-a", "dev-b"], terminal: ["term-a", "term-b"] },
    publicSnapshot: [
      { id: "doc/history-2", content: "second public history page\n" },
      { id: "doc/history-1", content: "first public history page\n" },
    ],
    panelEvidence: [
      { id: "panel/dev-a-1", content: "panel transcript for dev-a\n", cohort: "panel-a" as const, capsuleLabel: "dev-a", usage: USAGE },
    ],
    generatedAt: "2026-07-22T00:00:00.000Z",
  };
}

describe("corpus provenance assembly: partition and hash derivation", () => {
  it("derives ids from the manifests, partitions by the frozen mapping, and unions terminal content hashes", () => {
    const inputs = fixtureInputs();
    const artifact = assembleCorpusProvenance(inputs);

    const devIds = [inputs.capsules["dev-a"]!.manifest.id, inputs.capsules["dev-b"]!.manifest.id].sort();
    const termIds = [inputs.capsules["term-a"]!.manifest.id, inputs.capsules["term-b"]!.manifest.id].sort();
    expect(artifact.developmentCapsuleIds).toEqual(devIds);
    expect(artifact.terminalCapsuleIds).toEqual(termIds);
    expect(artifact.capsules.map((capsule) => capsule.id)).toEqual([...devIds, ...termIds].sort());
    for (const capsule of artifact.capsules) {
      const admitted = Object.values(inputs.capsules).find((entry) => entry.manifest.id === capsule.id);
      expect(capsule.digest).toBe(admitted?.digest);
      expect(capsule.role).toBe(devIds.includes(capsule.id) ? "development" : "terminal");
    }

    // Denylist = sorted unique union over TERMINAL manifests only.
    const expectedDenylist = [
      ...new Set([
        ...Object.values(inputs.capsules["term-a"]!.manifest.contentHashes),
        ...Object.values(inputs.capsules["term-b"]!.manifest.contentHashes),
      ]),
    ].sort();
    expect(artifact.terminalContentHashes).toEqual(expectedDenylist);
    for (const hash of Object.values(inputs.capsules["dev-a"]!.manifest.contentHashes)) {
      expect(artifact.terminalContentHashes).not.toContain(hash);
    }

    // Every document byte is bound; the public snapshot digest is canonical over sorted {id, contentHash}.
    expect(artifact.docHashes).toEqual({
      "doc/history-1": sha("first public history page\n"),
      "doc/history-2": sha("second public history page\n"),
      "panel/dev-a-1": sha("panel transcript for dev-a\n"),
    });
    const pairs = [
      { id: "doc/history-1", contentHash: sha("first public history page\n") },
      { id: "doc/history-2", contentHash: sha("second public history page\n") },
    ];
    expect(artifact.publicSnapshotDigest).toBe(`sha256:${createHash("sha256").update(canonicalJson(pairs)).digest("hex")}`);
    expect(artifact.panelDocs).toEqual([
      {
        id: "panel/dev-a-1",
        contentHash: sha("panel transcript for dev-a\n"),
        cohort: "panel-a",
        capsuleId: inputs.capsules["dev-a"]!.manifest.id,
        usage: USAGE,
      },
    ]);
  });

  it("binds the panel usage vector into the artifact digest", () => {
    const first = assembleCorpusProvenance(fixtureInputs());
    const remetered = fixtureInputs();
    remetered.panelEvidence = [
      { id: "panel/dev-a-1", content: "panel transcript for dev-a\n", cohort: "panel-a", capsuleLabel: "dev-a", usage: { ...USAGE, tokens: 999_999 } },
    ];
    const second = assembleCorpusProvenance(remetered);
    // Same bytes, different metering => different binding.
    expect(second.docHashes).toEqual(first.docHashes);
    expect(second.inputsDigest).not.toBe(first.inputsDigest);
  });

  it("is deterministic for identical inputs and shifts inputsDigest when any input changes", () => {
    const first = assembleCorpusProvenance(fixtureInputs());
    const second = assembleCorpusProvenance(fixtureInputs());
    expect(second).toEqual(first);

    const changed = fixtureInputs();
    changed.publicSnapshot = [...changed.publicSnapshot.slice(0, 1), { id: "doc/history-1", content: "revised page\n" }];
    const third = assembleCorpusProvenance(changed);
    expect(third.inputsDigest).not.toBe(first.inputsDigest);
    expect(third.publicSnapshotDigest).not.toBe(first.publicSnapshotDigest);
  });
});

describe("corpus provenance assembly: refusals", () => {
  it("refuses a provisional capsule (quarantine)", () => {
    const inputs = fixtureInputs();
    inputs.capsules["dev-b"] = { ...inputs.capsules["dev-b"]!, provisional: true };
    expect(() => assembleCorpusProvenance(inputs)).toThrow(/provisional/);
  });

  it("refuses a mapping label with no admitted capsule", () => {
    const inputs = fixtureInputs();
    delete inputs.capsules["term-b"];
    expect(() => assembleCorpusProvenance(inputs)).toThrow(/no admitted capsule/);
  });

  it("refuses an admitted capsule absent from the frozen mapping", () => {
    const inputs = fixtureInputs();
    inputs.capsules["stray"] = admittedFixture("stray", ["9"]);
    expect(() => assembleCorpusProvenance(inputs)).toThrow(/absent from the frozen role mapping/);
  });

  it("refuses a label mapped to both roles", () => {
    const inputs = fixtureInputs();
    inputs.mapping = { development: ["dev-a", "dev-b"], terminal: ["term-a", "term-b", "dev-a"] };
    expect(() => assembleCorpusProvenance(inputs)).toThrow(/more than once/);
  });

  it("refuses a digest that does not match the manifest (digest binding at assembly)", () => {
    const inputs = fixtureInputs();
    inputs.capsules["dev-a"] = { ...inputs.capsules["dev-a"]!, digest: fakeHash("d") };
    expect(() => assembleCorpusProvenance(inputs)).toThrow(/does not match its manifest/);
  });

  it("refuses a manifest whose id does not derive from its content", () => {
    const inputs = fixtureInputs();
    const admitted = inputs.capsules["dev-a"]!;
    const manifest = { ...admitted.manifest, id: "cap_000000000000" };
    inputs.capsules["dev-a"] = { manifest, digest: capsuleDigest(manifest), provisional: false };
    expect(() => assembleCorpusProvenance(inputs)).toThrow(/does not derive/);
  });

  it("refuses panel evidence attributed to a terminal capsule", () => {
    const inputs = fixtureInputs();
    inputs.panelEvidence = [{ id: "panel/x", content: "leaky\n", cohort: "panel-a", capsuleLabel: "term-a", usage: USAGE }];
    expect(() => assembleCorpusProvenance(inputs)).toThrow(/not a development capsule/);
  });

  it("refuses a document that mentions a terminal capsule identity", () => {
    const inputs = fixtureInputs();
    const terminalId = inputs.capsules["term-a"]!.manifest.id;
    inputs.publicSnapshot = [{ id: "doc/leak", content: `see ${terminalId} for details\n` }];
    expect(() => assembleCorpusProvenance(inputs)).toThrow(/terminal capsule identity/);
  });

  it("refuses duplicate document ids across public snapshot and panel evidence", () => {
    const inputs = fixtureInputs();
    inputs.panelEvidence = [{ id: "doc/history-1", content: "shadow\n", cohort: "panel-a", capsuleLabel: "dev-a", usage: USAGE }];
    expect(() => assembleCorpusProvenance(inputs)).toThrow(/duplicate corpus document id/);
  });
});

describe("corpus provenance artifact: digest-bound persistence", () => {
  it("round-trips through disk and verifies the binding", () => {
    const root = makeRoot();
    const artifact = assembleCorpusProvenance(fixtureInputs());
    const path = writeCorpusProvenanceArtifact(join(root, "corpus-provenance.v1.json"), artifact);
    expect(readCorpusProvenanceArtifact(path)).toEqual(artifact);
  });

  it("refuses a tampered artifact on read", () => {
    const root = makeRoot();
    const artifact = assembleCorpusProvenance(fixtureInputs());
    const path = writeCorpusProvenanceArtifact(join(root, "corpus-provenance.v1.json"), artifact);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw["terminalContentHashes"] = [];
    writeFileSync(path, `${JSON.stringify(raw)}\n`);
    expect(() => readCorpusProvenanceArtifact(path)).toThrow(/drifted since assembly/);
  });

  it("refuses a re-metered panelDocs usage on read — usage lives inside the binding", () => {
    const root = makeRoot();
    const artifact = assembleCorpusProvenance(fixtureInputs());
    const path = writeCorpusProvenanceArtifact(join(root, "corpus-provenance.v1.json"), artifact);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { panelDocs: { usage: { tokens: number } }[] };
    raw.panelDocs[0]!.usage.tokens += 1;
    writeFileSync(path, `${JSON.stringify(raw)}\n`);
    expect(() => readCorpusProvenanceArtifact(path)).toThrow(/drifted since assembly/);
  });
});

describe("buildBrokerCorpusConfig: minting the wire config", () => {
  const CONFIG_HASH = fakeHash("c");

  interface Minted {
    config: BrokerCorpusConfig;
    artifact: CorpusProvenanceV1;
    inputs: CorpusProvenanceInputs & { capsules: Record<string, AdmittedCorpusCapsule> };
  }
  function minted(): Minted {
    const inputs = fixtureInputs();
    const artifact = assembleCorpusProvenance(inputs);
    const config = buildBrokerCorpusConfig({
      provenance: artifact,
      campaignConfigHash: CONFIG_HASH,
      publicSnapshot: inputs.publicSnapshot,
      panelEvidence: inputs.panelEvidence.map((document) => ({ id: document.id, content: document.content })),
    });
    return { config, artifact, inputs };
  }

  it("stamps provenance from the artifact and self-verifies against the broker snapshot hash", () => {
    const { config, artifact, inputs } = minted();
    expect(config.provenance).toEqual({
      campaignConfigHash: CONFIG_HASH,
      developmentCapsuleIds: artifact.developmentCapsuleIds,
      terminalCapsuleIds: artifact.terminalCapsuleIds,
      terminalContentHashes: artifact.terminalContentHashes,
      // The wire config names the exact verified artifact that minted it.
      provenanceInputsDigest: artifact.inputsDigest,
    });
    expect(config.publicSnapshot.hash).toBe(hashCorpusSnapshot(config.publicSnapshot.documents));
    expect(config.publicSnapshot.documents.map((document) => document.id).sort()).toEqual(["doc/history-1", "doc/history-2"]);
    const panel = config.panelEvidence[0];
    expect(panel?.provenance).toEqual({
      campaignConfigHash: CONFIG_HASH,
      cohort: "panel-a",
      capsuleId: inputs.capsules["dev-a"]!.manifest.id,
    });
    // Usage is sourced from the digest-bound artifact — the minting inputs
    // carry content only, so the same artifact cannot mint re-metered docs.
    expect(panel?.usage).toEqual(USAGE);
  });

  it("refuses drifted document bytes and uncovered bindings", () => {
    const inputs = fixtureInputs();
    const artifact = assembleCorpusProvenance(inputs);
    const panelEvidence = inputs.panelEvidence.map((document) => ({ id: document.id, content: document.content }));
    expect(() =>
      buildBrokerCorpusConfig({
        provenance: artifact,
        campaignConfigHash: CONFIG_HASH,
        publicSnapshot: [{ id: "doc/history-1", content: "tampered\n" }, inputs.publicSnapshot[0]!],
        panelEvidence,
      }),
    ).toThrow(/does not reproduce its bound hash/);
    expect(() =>
      buildBrokerCorpusConfig({
        provenance: artifact,
        campaignConfigHash: CONFIG_HASH,
        publicSnapshot: inputs.publicSnapshot.slice(0, 1),
        panelEvidence,
      }),
    ).toThrow(/were not supplied/);
    expect(() =>
      buildBrokerCorpusConfig({
        provenance: artifact,
        campaignConfigHash: CONFIG_HASH,
        publicSnapshot: [...inputs.publicSnapshot, { id: "doc/extra", content: "unbound\n" }],
        panelEvidence,
      }),
    ).toThrow(/not bound by the provenance artifact/);
  });

  it("refuses a tampered artifact binding", () => {
    const { artifact, inputs } = { artifact: assembleCorpusProvenance(fixtureInputs()), inputs: fixtureInputs() };
    const forged = { ...artifact, terminalContentHashes: [] };
    expect(() =>
      buildBrokerCorpusConfig({
        provenance: forged,
        campaignConfigHash: CONFIG_HASH,
        publicSnapshot: inputs.publicSnapshot,
        panelEvidence: [],
      }),
    ).toThrow(/inputsDigest mismatch/);
  });
});

describe("corpusCohortFenceError: frozen config and wire config must share one artifact", () => {
  interface Fenced {
    config: BrokerCorpusConfig;
    cohort: CorpusCohortBinding;
  }
  function fenced(): Fenced {
    const inputs = fixtureInputs();
    const artifact = assembleCorpusProvenance(inputs);
    const config = buildBrokerCorpusConfig({
      provenance: artifact,
      campaignConfigHash: fakeHash("c"),
      publicSnapshot: inputs.publicSnapshot,
      panelEvidence: inputs.panelEvidence.map((document) => ({ id: document.id, content: document.content })),
    });
    return {
      config,
      cohort: {
        developmentCapsuleIds: artifact.developmentCapsuleIds,
        terminalCapsuleIds: artifact.terminalCapsuleIds,
        provenanceInputsDigest: artifact.inputsDigest,
      },
    };
  }

  it("binds when digest and id sets match, order-insensitively", () => {
    const { config, cohort } = fenced();
    expect(corpusCohortFenceError(config, cohort)).toBeNull();
    expect(corpusCohortFenceError(config, {
      ...cohort,
      developmentCapsuleIds: [...cohort.developmentCapsuleIds].reverse(),
      terminalCapsuleIds: [...cohort.terminalCapsuleIds].reverse(),
    })).toBeNull();
  });

  it("refuses a cohort from a different provenance artifact", () => {
    const { config, cohort } = fenced();
    expect(corpusCohortFenceError(config, { ...cohort, provenanceInputsDigest: fakeHash("d") }))
      .toMatch(/different provenance artifacts/);
  });

  it("refuses diverging development or terminal id sets", () => {
    const { config, cohort } = fenced();
    expect(corpusCohortFenceError(config, {
      ...cohort,
      developmentCapsuleIds: cohort.developmentCapsuleIds.slice(0, 1),
    })).toMatch(/development capsule ids differ/);
    expect(corpusCohortFenceError(config, {
      ...cohort,
      terminalCapsuleIds: [...cohort.terminalCapsuleIds.slice(0, 1), "cap_000000000000"],
    })).toMatch(/terminal capsule ids differ/);
  });

  it("refuses a wire config that never carried an artifact binding", () => {
    const { config, cohort } = fenced();
    const unbound = { ...config, provenance: { ...config.provenance, provenanceInputsDigest: undefined } };
    expect(corpusCohortFenceError(unbound, cohort)).toMatch(/no provenance artifact binding/);
  });
});

describe("broker wiring: ctx.corpus reaches the broker", () => {
  function res(overrides: Partial<CmdResult> = {}): CmdResult {
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
  }

  function corpusConfig(): BrokerCorpusConfig {
    const inputs = fixtureInputs();
    const artifact = assembleCorpusProvenance(inputs);
    return buildBrokerCorpusConfig({
      provenance: artifact,
      campaignConfigHash: fakeHash("c"),
      publicSnapshot: inputs.publicSnapshot,
      panelEvidence: inputs.panelEvidence.map((document) => ({ id: document.id, content: document.content })),
    });
  }

  /** Scripted-docker setup-only pass (see wiring.test.ts): egress + broker init, no optimizer. */
  async function startWithCorpus(corpus: BrokerCorpusConfig): Promise<void> {
    const root = makeRoot();
    const runId = "run_corpus";
    const runDir = join(root, ".hone-runs", runId);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(root, ".hone-cas"), { recursive: true });
    const baseline = join(root, "capsule", "baseline");
    initScratchRepo(baseline);
    const commit = gitIn(baseline, "rev-parse", "HEAD");
    const capsuleDir = makeCapsule(root, { baseline: { kind: "git", commit } });
    const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")));
    freezeCapsuleAssets(runDir, capsuleDir, manifest);
    appendEvent(runDir, { runId, at: at(), type: "run.started", capsuleId: manifest.id, contractHash: fakeHash("c"), optimizerDigest: fakeHash("0") });

    const run: RunCommand = (argv) => {
      if (argv[1] === "info") return Promise.resolve(res({ stdout: Buffer.from("ENGINE-TEST\n") }));
      if (argv[1] === "network" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("true\n") }));
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("d0n0r1d\n") }));
      const outArg = argv.find((a) => typeof a === "string" && a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
      if (argv[1] === "exec" && outArg !== undefined) {
        mkdirSync(join(runDir, "scratch-snapshot"), { recursive: true });
        writeFileSync(join(runDir, "scratch-snapshot", outArg.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length)), "");
      }
      return Promise.resolve(res());
    };
    const abort = new AbortController();
    abort.abort(new Error("stop requested"));
    const ctx: RunnerBackendContext = {
      runId,
      root,
      runDir,
      casDir: join(root, ".hone-cas"),
      capsuleDir,
      manifest,
      config: RunConfig.parse({
        version: 1,
        capsuleId: manifest.id,
        objective: manifest.objective,
        budget: manifest.budget,
        routing: { mutation: { model: "m" } },
        headless: true,
      }),
      env: { PATH: process.env["PATH"] ?? "", HONE_EGRESS: "network" },
      capsuleDigest: capsuleDigest(manifest),
      admissionReview: "off",
      optimizerDigest: fakeHash("0"),
      corpus,
      replayed: replayRun(runDir),
      signal: abort.signal,
      emit: (event) => appendEvent(runDir, event),
      registerChild: () => () => {},
      probeGate: () => Promise.resolve(true),
      requestStop: () => {},
      registerAuthorityBarrier: (b) => {
        void b.catch(() => {});
      },
      registerCleanupBarrier: (b) => {
        void b.catch(() => {});
      },
    };
    await createBackend({ run, createHelper: scriptedCreateHelper(run) }).start(ctx);
  }

  it("a valid corpus config passes broker construction end to end", { timeout: 30_000 }, async () => {
    await expect(startWithCorpus(corpusConfig())).resolves.toBeUndefined();
  });

  it("a corrupted snapshot hash refuses at broker construction — proof the config crossed the wire", { timeout: 30_000 }, async () => {
    const corrupted = { ...corpusConfig(), publicSnapshot: { hash: fakeHash("f"), documents: corpusConfig().publicSnapshot.documents } };
    await expect(startWithCorpus(corrupted)).rejects.toThrow(/snapshot hash does not match/);
  });
});

describe("campaign corpus seal: durable digest at creation, exact match on resume", () => {
  const CONFIG_HASH = `sha256:${"c".repeat(64)}` as const;

  function mintCorpus(campaignConfigHash: string, historyContent = "first public history page\n"): BrokerCorpusConfig {
    const inputs = fixtureInputs();
    inputs.publicSnapshot = [inputs.publicSnapshot[0]!, { id: "doc/history-1", content: historyContent }];
    const artifact = assembleCorpusProvenance(inputs);
    return buildBrokerCorpusConfig({
      provenance: artifact,
      campaignConfigHash,
      publicSnapshot: inputs.publicSnapshot,
      panelEvidence: inputs.panelEvidence.map((document) => ({ id: document.id, content: document.content })),
    });
  }

  function pauseAuthority(root: string): CampaignPauseAuthority {
    return {
      path: join(root, "campaign-pause.v1.json"),
      configHash: CONFIG_HASH,
      isCampaignPaused: () => false,
      recordCampaignPause: () => undefined,
      recordCampaignResume: () => undefined,
    };
  }

  function cohortOf(corpus: BrokerCorpusConfig): CorpusCohortBinding {
    if (corpus.provenance.provenanceInputsDigest === undefined) throw new Error("minted config lost its binding");
    return {
      developmentCapsuleIds: corpus.provenance.developmentCapsuleIds,
      terminalCapsuleIds: corpus.provenance.terminalCapsuleIds,
      provenanceInputsDigest: corpus.provenance.provenanceInputsDigest,
    };
  }

  it("a fresh campaign run persists the canonical corpus digest into the session seal", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const corpus = mintCorpus(CONFIG_HASH);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    expect(await cliRunCommand(["capsule", "--headless", "--backend", "stub"], io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(root),
      proxyRole: "inner-capsule-improvement",
      corpus,
      corpusCohort: cohortOf(corpus),
    })).toBe(0);
    const runsDir = join(root, ".hone-runs");
    const entries = readdirSync(runsDir);
    expect(entries.length).toBe(1);
    const seal = JSON.parse(readFileSync(join(runsDir, entries[0]!, "campaign-session.v1.json"), "utf8")) as Record<string, unknown>;
    expect(seal["corpusDigest"]).toBe(brokerCorpusConfigDigest(corpus));
  });

  it("a corpus without its corpusCohort binding refuses pre-run-state (fresh)", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub"], io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(root),
      proxyRole: "inner-capsule-improvement",
      corpus: mintCorpus(CONFIG_HASH),
    })).rejects.toThrow(/requires the campaign corpusCohort binding/);
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });

  it("a corpus without a campaign config seal refuses before any run dir exists", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub"], io, {
      corpus: mintCorpus(CONFIG_HASH),
    })).rejects.toThrow(/require a trusted campaign config seal/);
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });

  it("a corpus stamped with a foreign campaign hash refuses at run creation", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub"], io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(root),
      proxyRole: "inner-capsule-improvement",
      corpus: mintCorpus(fakeHash("e")),
    })).rejects.toThrow(/does not carry the trusted campaign config hash/);
  });

  it("a matching corpusCohort passes the run-time fence; a foreign or unpaired one refuses pre-run-state", async () => {
    const matchedRoot = makeRoot();
    makeCapsule(matchedRoot);
    const corpus = mintCorpus(CONFIG_HASH);
    expect(await cliRunCommand(["capsule", "--headless", "--backend", "stub"], makeIo(matchedRoot, { HONE_STUB_EPISODES: "1" }).io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(matchedRoot),
      proxyRole: "inner-capsule-improvement",
      corpus,
      corpusCohort: cohortOf(corpus),
    })).toBe(0);

    // Cohort generated from a DIFFERENT provenance artifact than the wire config.
    const foreignRoot = makeRoot();
    makeCapsule(foreignRoot);
    const foreignCohort = cohortOf(mintCorpus(CONFIG_HASH, "revised public history page\n"));
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub"], makeIo(foreignRoot, { HONE_STUB_EPISODES: "1" }).io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(foreignRoot),
      proxyRole: "inner-capsule-improvement",
      corpus: mintCorpus(CONFIG_HASH),
      corpusCohort: foreignCohort,
    })).rejects.toThrow(/different provenance artifacts/);
    expect(existsSync(join(foreignRoot, ".hone-runs"))).toBe(false);

    // Cohort without any corpus wire config: fail-closed.
    const unpairedRoot = makeRoot();
    makeCapsule(unpairedRoot);
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub"], makeIo(unpairedRoot, { HONE_STUB_EPISODES: "1" }).io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(unpairedRoot),
      proxyRole: "inner-capsule-improvement",
      corpusCohort: cohortOf(mintCorpus(CONFIG_HASH)),
    })).rejects.toThrow(/requires the frozen corpus wire config/);
    expect(existsSync(join(unpairedRoot, ".hone-runs"))).toBe(false);
  });

  it("a diverged corpusCohort id set refuses on resume before any event append", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const corpus = mintCorpus(CONFIG_HASH);
    const runDir = sealedResumeFixture(root, corpus);
    const before = readFileSync(join(runDir, "events.ndjson"), "utf8");
    const cohort = cohortOf(corpus);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub", "--resume"], io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(root),
      proxyRole: "inner-capsule-improvement",
      corpus,
      corpusCohort: { ...cohort, developmentCapsuleIds: cohort.developmentCapsuleIds.slice(0, 1) },
    })).rejects.toThrow(/development capsule ids differ/);
    expect(readFileSync(join(runDir, "events.ndjson"), "utf8")).toBe(before);
  });

  /** An unfinished campaign-sealed run dir with a corpus digest in its session seal. */
  function sealedResumeFixture(root: string, corpus: BrokerCorpusConfig): string {
    const events = fixtureEvents({
      runId: "run_corpus_child",
      baselineHash: fakeHash("b"),
      bestHash: fakeHash("d"),
      finished: false,
    });
    const started = events[0];
    if (started?.type !== "run.started") throw new Error("fixture is missing run.started");
    events[0] = { ...started, campaignConfigHash: CONFIG_HASH };
    const runDir = writeEvents(root, "run_corpus_child", events);
    writeCapsuleSnapshot(runDir, manifestObject());
    writeRunConfigFile(runDir, runConfigFixture());
    writeFileSync(join(runDir, "campaign-session.v1.json"), `${JSON.stringify({
      version: 1,
      campaignConfigHash: CONFIG_HASH,
      authorityPath: join(root, "campaign-pause.v1.json"),
      proxyRole: "inner-capsule-improvement",
      corpusDigest: brokerCorpusConfigDigest(corpus),
    })}\n`);
    return runDir;
  }

  function resumeWith(root: string, corpus: BrokerCorpusConfig | undefined): Promise<number> {
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    return cliRunCommand(["capsule", "--headless", "--backend", "stub", "--resume"], io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(root),
      proxyRole: "inner-capsule-improvement",
      ...(corpus === undefined ? {} : { corpus, corpusCohort: cohortOf(corpus) }),
    });
  }

  it("resume refuses a corpus without its corpusCohort binding before any event append", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const corpus = mintCorpus(CONFIG_HASH);
    const runDir = sealedResumeFixture(root, corpus);
    const before = readFileSync(join(runDir, "events.ndjson"), "utf8");
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub", "--resume"], io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(root),
      proxyRole: "inner-capsule-improvement",
      corpus,
    })).rejects.toThrow(/requires the campaign corpusCohort binding/);
    expect(readFileSync(join(runDir, "events.ndjson"), "utf8")).toBe(before);
  });

  it("resume refuses a missing or different corpus and accepts only the exact sealed digest", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const corpus = mintCorpus(CONFIG_HASH);
    const runDir = sealedResumeFixture(root, corpus);
    const before = readFileSync(join(runDir, "events.ndjson"), "utf8");

    // Omitted corpus: the sealed digest cannot be satisfied.
    await expect(resumeWith(root, undefined)).rejects.toThrow(/campaign corpus seal changed since the run started/);
    // Different (still internally valid) corpus: exact-digest requirement refuses.
    await expect(resumeWith(root, mintCorpus(CONFIG_HASH, "revised public history page\n")))
      .rejects.toThrow(/campaign corpus seal changed since the run started/);
    // Corpus stamped with a foreign campaign hash refuses on its provenance, not just the digest.
    await expect(resumeWith(root, mintCorpus(fakeHash("e"))))
      .rejects.toThrow(/does not carry the run's sealed campaign config hash/);
    // No refusal appended an event.
    expect(readFileSync(join(runDir, "events.ndjson"), "utf8")).toBe(before);

    // The exact corpus passes every corpus gate: whatever later fixture gap
    // stops this synthetic resume, it is never a corpus refusal.
    const outcome = await resumeWith(root, corpus).then(() => null, (error: unknown) => error);
    if (outcome !== null) {
      expect(outcome instanceof Error ? outcome.message : String(outcome))
        .not.toMatch(/corpus seal|corpus provenance|frozen corpus/);
    }
  });

  it("a legacy (non-campaign) run cannot acquire a corpus on resume", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const runDir = writeEvents(root, "run_legacy", fixtureEvents({
      runId: "run_legacy",
      baselineHash: fakeHash("b"),
      bestHash: fakeHash("d"),
      finished: false,
    }));
    writeCapsuleSnapshot(runDir, manifestObject());
    writeRunConfigFile(runDir, runConfigFixture());
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub", "--resume"], io, {
      corpus: mintCorpus(CONFIG_HASH),
    })).rejects.toThrow(/frozen corpus on resume/);
  });

  it("provisional admission quarantine refuses a corpus before any run state exists", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const digest = capsuleDigest(manifestObject());
    const identities: AdmissionReceiptRecordBody["identities"] = {
      author: { identity: "capsule-author", kind: "agent" },
      "adversarial-validator": { identity: "red-team", kind: "agent" },
      "final-reviewer": { identity: "delegated-reviewer", kind: "agent" },
    };
    const receipt = (
      sequence: number,
      previousReceiptHash: string | null,
      action: AdmissionReceiptRecordBody["action"],
      provisional: boolean,
      delegation?: AdmissionReceiptRecordBody["delegation"],
    ): AdmissionReceiptRecord => {
      const body: AdmissionReceiptRecordBody = {
        v: 1,
        sequence,
        previousReceiptHash,
        capsuleDigest: digest,
        action,
        identities,
        ...(delegation === undefined ? {} : { delegation }),
        provisional,
        timestamp: `2026-07-18T12:00:0${sequence}.000Z`,
      };
      return AdmissionReceiptRecord.parse({ ...body, recordHash: admissionReceiptRecordHash(body) });
    };
    const gate1 = receipt(0, null, "gate1-accept", false);
    const gate2 = receipt(1, gate1.recordHash, "gate2-approve", true, {
      delegator: { identity: "repository-owner", kind: "owner" },
      delegate: { identity: "delegated-reviewer", kind: "agent" },
      scope: "provisional-private-apply-none",
      budgetUsd: 10,
    });
    appendAdmissionReceipt(join(root, ".hone-cas"), gate1);
    appendAdmissionReceipt(join(root, ".hone-cas"), gate2);

    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    // Delegated private approval => provisional admission; a broker corpus
    // (queryCorpus capability) must never reach such a run.
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub"], io, {
      campaignConfigHash: CONFIG_HASH,
      campaignPauseAuthority: pauseAuthority(root),
      proxyRole: "inner-capsule-improvement",
      corpus: mintCorpus(CONFIG_HASH),
    })).rejects.toThrow(/provisional capsule quarantine/);
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });
});

function runConfigFixture(): RunConfig {
  return RunConfig.parse({
    version: 1,
    capsuleId: CAP_ID,
    objective: "fixture objective",
    budget: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
    routing: { mutation: { model: "test-model" } },
    headless: true,
  });
}
