import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CapsuleManifest } from "@hone/schema";
import { UsageError } from "./args.js";

export function loadCapsule(dir: string): CapsuleManifest {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new UsageError(`no capsule manifest at ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`capsule manifest ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = CapsuleManifest.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new UsageError(`invalid capsule manifest ${path}:\n${issues}`);
  }
  return result.data;
}
