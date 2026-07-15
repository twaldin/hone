import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CapsuleManifest } from "@hone/schema";
import { describe, expect, it } from "vitest";
import { canonicalJson, deriveCapId, scaffold } from "../tools/scaffold.js";

const CAPSULES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TASK_DIR = join(CAPSULES_DIR, "seeded-astar");

describe("canonicalJson", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalJson({ b: { d: 2, c: [3, 1] }, a: 0 })).toBe(
      '{"a":0,"b":{"c":[3,1],"d":2}}',
    );
  });

  it("drops undefined-valued keys", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("deriveCapId", () => {
  it("is insensitive to key order and ignores a present id", () => {
    const a = deriveCapId({ x: 1, y: [2, 3], id: "cap_aaaaaaaaaaaa" });
    const b = deriveCapId({ y: [2, 3], x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^cap_[0-9a-f]{12}$/);
  });

  it("changes when content changes", () => {
    expect(deriveCapId({ x: 1 })).not.toBe(deriveCapId({ x: 2 }));
  });
});

describe("scaffold(seeded-astar)", () => {
  it("produces a zod-valid manifest with a reproducible content-addressed id", () => {
    const first = scaffold(TASK_DIR);
    const second = scaffold(TASK_DIR);
    expect(second.id).toBe(first.id);

    // What landed on disk is the validated manifest, and re-deriving the id
    // from the written file round-trips.
    const written = CapsuleManifest.parse(
      JSON.parse(readFileSync(join(TASK_DIR, "manifest.json"), "utf8")),
    );
    expect(written).toEqual(first);
    expect(deriveCapId(written)).toBe(written.id);
  });

  it("covers every asset-group file with a content hash", () => {
    const manifest = scaffold(TASK_DIR);
    const hashed = Object.keys(manifest.contentHashes).sort();
    const referenced = manifest.assetGroups.flatMap((g) => g.paths).sort();
    expect(hashed).toEqual(referenced);
    expect(referenced.length).toBe(14); // 6 train + 4 validation + 4 holdout
  });
});
