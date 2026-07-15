import { createHash } from "node:crypto";
import type { CapsuleManifest } from "./capsule.js";

/**
 * THE canonical JSON implementation. Scaffold tooling and the trusted runtime
 * MUST share these exports — duplicating any of them elsewhere is a
 * conformance bug (two "canonical" serializers cannot both be canonical).
 *
 * Rules: recursively sorted object keys (codepoint order), no whitespace,
 * undefined-valued keys dropped.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Content-addressed capsule id: "cap_" + first 12 hex of sha256 over the
 * canonical manifest WITHOUT its id. A present `id` key is dropped, so the
 * derivation is idempotent over already-stamped manifests.
 */
export function deriveCapsuleId(manifestSansId: Record<string, unknown>): string {
  const { id: _dropped, ...rest } = manifestSansId;
  const digest = createHash("sha256").update(canonicalJson(rest)).digest("hex");
  return `cap_${digest.slice(0, 12)}`;
}

/**
 * Full-strength digest of the complete manifest INCLUDING id:
 * "sha256:" + 64 hex over the canonical JSON. This is the pinning value the
 * trusted runtime records (BrokerConfig.capsuleDigest) — the 12-hex id is a
 * human handle, this is the integrity anchor.
 */
export function capsuleDigest(manifest: CapsuleManifest): string {
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}
