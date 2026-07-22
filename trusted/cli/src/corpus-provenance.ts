import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { z } from "zod";
import { hashCorpusSnapshot } from "@hone/broker";
import type { BrokerCorpusConfig } from "@hone/broker";
import {
  canonicalJson,
  capsuleDigest,
  deriveCapsuleId,
  CorpusPanelEvidence,
  CorpusPublicDocument,
  ResourceUsage,
  type CapsuleManifest,
} from "@hone/schema";
import { UsageError } from "./args.js";
import { writeFileDurable } from "./eventlog.js";

/**
 * M2 corpus provenance (launch-tooling item 1): the digest-bound bridge from
 * the admitted capsule cohort to the broker's frozen development corpus.
 *
 * The assembler consumes admitted manifests (ids/digests/content hashes are
 * ALWAYS read from the manifests at assembly time — cap_ ids drift across
 * re-scaffolds, so nothing here may be pinned by id), a frozen dev/terminal
 * role mapping keyed by stable capsule labels (directory names), the public
 * snapshot documents, and development-panel evidence. It derives the
 * BrokerCorpusConfig provenance policy inputs and persists them as a
 * self-verifying `corpus-provenance.v1.json` artifact; `inputsDigest` binds
 * every derived field, so any post-assembly edit refuses on read.
 *
 * The wire config for a run is minted late by buildBrokerCorpusConfig: the
 * campaignConfigHash only exists after freeze, so the artifact stays
 * campaign-hash-independent while every document byte and panel attribution
 * is already digest-bound.
 */

export const CORPUS_PROVENANCE_VERSION = "corpus-provenance.v1";
export const CORPUS_PROVENANCE_FILE = "corpus-provenance.v1.json";

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CAPSULE_ID = z.string().regex(/^cap_[0-9a-f]{12}$/);

export const CorpusCapsuleRecord = z
  .object({
    id: CAPSULE_ID,
    digest: SHA256,
    role: z.enum(["development", "terminal"]),
  })
  .strict();
export type CorpusCapsuleRecord = z.infer<typeof CorpusCapsuleRecord>;

/**
 * Digest-bound panel attribution AND metering: which development capsule
 * produced a panel document and the exact usage vector the broker serves.
 * Usage lives INSIDE the binding — a verified artifact cannot mint two
 * different candidate-visible panel documents by varying usage at run time.
 */
export const CorpusPanelDocRecord = z
  .object({
    id: z.string().min(1),
    contentHash: SHA256,
    cohort: z.enum(["panel-a", "panel-b"]),
    capsuleId: CAPSULE_ID,
    usage: ResourceUsage,
  })
  .strict();
export type CorpusPanelDocRecord = z.infer<typeof CorpusPanelDocRecord>;

export const CorpusProvenanceV1 = z
  .object({
    version: z.literal(CORPUS_PROVENANCE_VERSION),
    /** Every admitted cohort capsule, sorted by id. */
    capsules: z.array(CorpusCapsuleRecord).min(1),
    developmentCapsuleIds: z.array(CAPSULE_ID).min(1),
    terminalCapsuleIds: z.array(CAPSULE_ID).min(1),
    /** Sorted, de-duplicated union of every terminal manifest's contentHashes — the broker denylist. */
    terminalContentHashes: z.array(SHA256),
    /** Campaign-hash-independent digest over the sorted public {id, contentHash} pairs. */
    publicSnapshotDigest: SHA256,
    /** Every corpus document (public + panel), id → sha256 of its exact content. */
    docHashes: z.record(SHA256),
    panelDocs: z.array(CorpusPanelDocRecord),
    /** sha256 over the canonical JSON of every other field — the artifact's self-binding. */
    inputsDigest: SHA256,
    generatedAt: z.string().datetime(),
  })
  .strict();
export type CorpusProvenanceV1 = z.infer<typeof CorpusProvenanceV1>;

declare const CORPUS_PROVENANCE_VERIFIED: unique symbol;
/**
 * A CorpusProvenanceV1 whose inputsDigest has been recomputed and matched in
 * THIS process. Only verifyCorpusProvenance (and the loaders built on it) can
 * mint the brand — raw JSON.parse/schema-parse results cannot flow into
 * consumers that require it.
 */
export type VerifiedCorpusProvenance = CorpusProvenanceV1 & { readonly [CORPUS_PROVENANCE_VERIFIED]: true };

/** Structural subset of AdmittedCapsule — exactly what corpus assembly consumes. */
export interface AdmittedCorpusCapsule {
  manifest: CapsuleManifest;
  /** Canonical full-manifest digest from admission. */
  digest: string;
  /** Delegated private approvals are quarantined from every corpus statistic. */
  provisional: boolean;
}

/** Frozen role partition keyed by stable capsule labels (capsule directory names), never cap_ ids. */
export interface CorpusRoleMapping {
  development: readonly string[];
  terminal: readonly string[];
}

export interface PublicSnapshotDocumentInput {
  id: string;
  content: string;
}

export interface PanelEvidenceDocumentInput {
  id: string;
  content: string;
  cohort: "panel-a" | "panel-b";
  /** Stable capsule label; resolved to the CURRENT manifest id at assembly time. */
  capsuleLabel: string;
  /** Metered evidence vector, frozen into the binding at assembly. */
  usage: ResourceUsage;
}

export interface CorpusProvenanceInputs {
  /** Admitted cohort keyed by stable label. Must cover the mapping exactly. */
  capsules: Readonly<Record<string, AdmittedCorpusCapsule>>;
  mapping: CorpusRoleMapping;
  publicSnapshot: readonly PublicSnapshotDocumentInput[];
  panelEvidence: readonly PanelEvidenceDocumentInput[];
  /** Injectable clock for deterministic assembly; defaults to now. */
  generatedAt?: string | undefined;
}

function refuse(why: string): never {
  throw new UsageError(`corpus provenance refused: ${why}`);
}

function sha256Text(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}


/** Digest over every artifact field except the binding itself. */
export function corpusProvenanceInputsDigest(artifact: Omit<CorpusProvenanceV1, "inputsDigest">): string {
  const { version, capsules, developmentCapsuleIds, terminalCapsuleIds, terminalContentHashes, publicSnapshotDigest, docHashes, panelDocs, generatedAt } = artifact;
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        version,
        capsules,
        developmentCapsuleIds,
        terminalCapsuleIds,
        terminalContentHashes,
        publicSnapshotDigest,
        docHashes,
        panelDocs,
        generatedAt,
      }),
    )
    .digest("hex")}`;
}

export function assembleCorpusProvenance(inputs: CorpusProvenanceInputs): VerifiedCorpusProvenance {
  const labels = Object.keys(inputs.capsules);
  const development = [...inputs.mapping.development];
  const terminal = [...inputs.mapping.terminal];
  const mapped = [...development, ...terminal];
  if (new Set(mapped).size !== mapped.length) {
    refuse("the frozen role mapping names a capsule label more than once");
  }
  const roleByLabel = new Map<string, "development" | "terminal">();
  for (const label of development) roleByLabel.set(label, "development");
  for (const label of terminal) roleByLabel.set(label, "terminal");
  for (const label of mapped) {
    if (inputs.capsules[label] === undefined) refuse(`mapped capsule "${label}" has no admitted capsule`);
  }
  for (const label of labels) {
    if (!roleByLabel.has(label)) refuse(`admitted capsule "${label}" is absent from the frozen role mapping`);
  }

  const capsules: CorpusCapsuleRecord[] = [];
  const idByLabel = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const label of labels.sort()) {
    const admitted = inputs.capsules[label];
    if (admitted === undefined) refuse(`admitted capsule "${label}" disappeared during assembly`);
    if (admitted.provisional) {
      refuse(`capsule "${label}" (${admitted.manifest.id}) is provisional — quarantine forbids corpus membership`);
    }
    // Identity is read from the manifest at assembly time and re-derived —
    // a stale or hand-edited id/digest cannot enter the frozen corpus.
    if (deriveCapsuleId(admitted.manifest) !== admitted.manifest.id) {
      refuse(`capsule "${label}" manifest id ${admitted.manifest.id} does not derive from its content`);
    }
    if (capsuleDigest(admitted.manifest) !== admitted.digest) {
      refuse(`capsule "${label}" digest ${admitted.digest} does not match its manifest`);
    }
    if (seenIds.has(admitted.manifest.id)) refuse(`duplicate capsule id ${admitted.manifest.id}`);
    seenIds.add(admitted.manifest.id);
    idByLabel.set(label, admitted.manifest.id);
    const role = roleByLabel.get(label);
    if (role === undefined) refuse(`capsule "${label}" lost its mapped role during assembly`);
    capsules.push({ id: admitted.manifest.id, digest: admitted.digest, role });
  }
  capsules.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const resolveIds = (mappedLabels: readonly string[]): string[] =>
    mappedLabels
      .map((label) => {
        const id = idByLabel.get(label);
        if (id === undefined) refuse(`mapped capsule "${label}" resolved no manifest id`);
        return id;
      })
      .sort();
  const developmentCapsuleIds = resolveIds(development);
  const terminalCapsuleIds = resolveIds(terminal);

  const terminalContentHashes = [
    ...new Set(
      terminal.flatMap((label) => {
        const admitted = inputs.capsules[label];
        if (admitted === undefined) refuse(`terminal capsule "${label}" disappeared during assembly`);
        return Object.values(admitted.manifest.contentHashes);
      }),
    ),
  ].sort();

  const docHashes: Record<string, string> = {};
  const terminalHashSet = new Set(terminalContentHashes);
  const bindDocument = (id: string, content: string, kind: string): string => {
    if (id.length === 0) refuse(`a ${kind} document has an empty id`);
    if (Object.prototype.hasOwnProperty.call(docHashes, id)) refuse(`duplicate corpus document id "${id}"`);
    const contentHash = sha256Text(content);
    // Mirror the broker's frozen development-provenance rules at assembly
    // time so a leak refuses here, not at run start: no terminal bytes, no
    // terminal identity on the development wire.
    if (terminalHashSet.has(contentHash)) {
      refuse(`document "${id}" content is a terminal capsule asset`);
    }
    const identitySurface = `${id}\n${content}`.normalize("NFC");
    for (const terminalId of terminalCapsuleIds) {
      if (identitySurface.includes(terminalId.normalize("NFC"))) {
        refuse(`document "${id}" mentions terminal capsule identity ${terminalId}`);
      }
    }
    docHashes[id] = contentHash;
    return contentHash;
  };

  const publicPairs = inputs.publicSnapshot
    .map((document) => ({ id: document.id, contentHash: bindDocument(document.id, document.content, "public-snapshot") }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const publicSnapshotDigest = `sha256:${createHash("sha256").update(canonicalJson(publicPairs)).digest("hex")}`;

  const developmentIdSet = new Set(developmentCapsuleIds);
  const panelDocs: CorpusPanelDocRecord[] = inputs.panelEvidence
    .map((document) => {
      const capsuleId = idByLabel.get(document.capsuleLabel);
      if (capsuleId === undefined || !developmentIdSet.has(capsuleId)) {
        refuse(`panel evidence "${document.id}" is attributed to "${document.capsuleLabel}", which is not a development capsule`);
      }
      return {
        id: document.id,
        contentHash: bindDocument(document.id, document.content, "panel-evidence"),
        cohort: document.cohort,
        capsuleId,
        usage: ResourceUsage.parse(document.usage),
      };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const body = {
    version: CORPUS_PROVENANCE_VERSION,
    capsules,
    developmentCapsuleIds,
    terminalCapsuleIds,
    terminalContentHashes,
    publicSnapshotDigest,
    docHashes,
    panelDocs,
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
  } as const;
  return verifyCorpusProvenance(CorpusProvenanceV1.parse({ ...body, inputsDigest: corpusProvenanceInputsDigest(body) }), "assembled artifact");
}

/**
 * THE verification chokepoint: schema-parse plus inputsDigest recompute.
 * Every VerifiedCorpusProvenance in the process was minted here — raw
 * parses cannot carry the brand into drafting or run wiring.
 */
export function verifyCorpusProvenance(artifact: CorpusProvenanceV1, source = "corpus provenance artifact"): VerifiedCorpusProvenance {
  const parsed = CorpusProvenanceV1.parse(artifact);
  if (corpusProvenanceInputsDigest(parsed) !== parsed.inputsDigest) {
    refuse(`${source} inputsDigest mismatch — drifted since assembly`);
  }
  return parsed as VerifiedCorpusProvenance;
}

/** Durable canonical persistence; owner-only like every other trusted artifact. */
export function writeCorpusProvenanceArtifact(path: string, artifact: CorpusProvenanceV1): string {
  const parsed = verifyCorpusProvenance(artifact, "artifact to persist");
  writeFileDurable(path, `${canonicalJson(parsed)}\n`);
  chmodSync(path, 0o600);
  return path;
}

/** Read + schema-parse + digest-verify. Any drift since assembly refuses. */
export function readCorpusProvenanceArtifact(path: string): VerifiedCorpusProvenance {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    refuse(`${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = CorpusProvenanceV1.safeParse(raw);
  if (!parsed.success) refuse(`${path} is not a valid ${CORPUS_PROVENANCE_VERSION} artifact`);
  return verifyCorpusProvenance(parsed.data, path);
}

export interface BuildBrokerCorpusConfigInputs {
  provenance: CorpusProvenanceV1;
  /** Frozen campaign identity — exists only after freeze, so it is stamped late. */
  campaignConfigHash: string;
  publicSnapshot: readonly PublicSnapshotDocumentInput[];
  /** Content only — cohort, attribution, AND usage come from the digest-bound artifact. */
  panelEvidence: readonly PublicSnapshotDocumentInput[];
}

/**
 * Mint the broker wire config from the digest-bound artifact plus the exact
 * document bytes. Every document must reproduce its bound hash, cover the
 * artifact exactly (no extras, no gaps), and panel attribution + usage come
 * ONLY from the artifact — callers cannot re-attribute or re-meter evidence.
 */
export function buildBrokerCorpusConfig(inputs: BuildBrokerCorpusConfigInputs): BrokerCorpusConfig {
  const provenance = verifyCorpusProvenance(inputs.provenance, "provenance artifact");
  if (!/^sha256:[0-9a-f]{64}$/.test(inputs.campaignConfigHash)) {
    refuse("campaignConfigHash must be sha256:<64 hex>");
  }
  const panelById = new Map(provenance.panelDocs.map((document) => [document.id, document]));
  const consumed = new Set<string>();
  const boundHash = (id: string, content: string, kind: string): string => {
    const expected = provenance.docHashes[id];
    if (expected === undefined) refuse(`${kind} document "${id}" is not bound by the provenance artifact`);
    if (consumed.has(id)) refuse(`${kind} document "${id}" was supplied more than once`);
    consumed.add(id);
    const actual = sha256Text(content);
    if (actual !== expected) refuse(`${kind} document "${id}" content does not reproduce its bound hash`);
    return actual;
  };

  const documents = inputs.publicSnapshot.map((document) => {
    if (panelById.has(document.id)) refuse(`document "${document.id}" is bound as panel evidence, not public snapshot`);
    return CorpusPublicDocument.parse({
      source: "public-snapshot",
      provenance: { campaignConfigHash: inputs.campaignConfigHash, cohort: "public-history" },
      id: document.id,
      contentHash: boundHash(document.id, document.content, "public-snapshot"),
      content: document.content,
    });
  });
  const panelEvidence = inputs.panelEvidence.map((document) => {
    const bound = panelById.get(document.id);
    if (bound === undefined) refuse(`document "${document.id}" is not bound as panel evidence`);
    return CorpusPanelEvidence.parse({
      source: "panel-evidence",
      provenance: {
        campaignConfigHash: inputs.campaignConfigHash,
        cohort: bound.cohort,
        capsuleId: bound.capsuleId,
      },
      id: document.id,
      contentHash: boundHash(document.id, document.content, "panel-evidence"),
      content: document.content,
      usage: bound.usage,
    });
  });
  const missing = Object.keys(provenance.docHashes).filter((id) => !consumed.has(id));
  if (missing.length > 0) refuse(`bound corpus documents were not supplied: ${missing.sort().join(", ")}`);

  return {
    provenance: {
      campaignConfigHash: inputs.campaignConfigHash,
      developmentCapsuleIds: provenance.developmentCapsuleIds,
      terminalCapsuleIds: provenance.terminalCapsuleIds,
      terminalContentHashes: provenance.terminalContentHashes,
      // Run-time fence material: which verified artifact minted this config.
      provenanceInputsDigest: provenance.inputsDigest,
    },
    publicSnapshot: { hash: hashCorpusSnapshot(documents), documents },
    panelEvidence,
  };
}

/**
 * Canonical digest of the EXACT wire config a broker receives. The campaign
 * session seal binds it at run creation; a resume must reproduce it bit for
 * bit before supervision.
 */
export function brokerCorpusConfigDigest(corpus: BrokerCorpusConfig): string {
  return `sha256:${createHash("sha256").update(canonicalJson(corpus)).digest("hex")}`;
}

/** The frozen campaign config's corpusCohort block, as the trusted orchestration hands it to a run. */
export interface CorpusCohortBinding {
  developmentCapsuleIds: readonly string[];
  terminalCapsuleIds: readonly string[];
  /** inputsDigest of the corpus-provenance.v1 artifact the frozen config was generated from. */
  provenanceInputsDigest: string;
}

/**
 * Run-time cohort fence: the sealed campaign config and the corpus wire
 * config must descend from the SAME verified provenance artifact — matching
 * inputsDigest and identical dev/terminal id sets (order-insensitive). Null
 * = bound; otherwise the exact refusal reason. Fail-closed: a wire config
 * that never carried an artifact binding refuses too.
 */
export function corpusCohortFenceError(corpus: BrokerCorpusConfig, cohort: CorpusCohortBinding): string | null {
  if (corpus.provenance.provenanceInputsDigest === undefined) {
    return "corpus wire config carries no provenance artifact binding";
  }
  if (corpus.provenance.provenanceInputsDigest !== cohort.provenanceInputsDigest) {
    return "campaign corpusCohort and the corpus wire config descend from different provenance artifacts (inputsDigest mismatch)";
  }
  const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return rightSet.size === right.length && left.every((id) => rightSet.has(id));
  };
  if (!sameSet(corpus.provenance.developmentCapsuleIds, cohort.developmentCapsuleIds)) {
    return "campaign corpusCohort development capsule ids differ from the corpus wire config";
  }
  if (!sameSet(corpus.provenance.terminalCapsuleIds, cohort.terminalCapsuleIds)) {
    return "campaign corpusCohort terminal capsule ids differ from the corpus wire config";
  }
  return null;
}
