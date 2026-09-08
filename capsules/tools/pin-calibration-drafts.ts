import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CapsuleManifest, DiagnosticOrderingReport, deriveCapsuleId, validateDiagnosticOrdering } from "@hone/schema";

// Authoring only: existing scaffold/admission intentionally refuse these reports.
// A draft ID is real and content-addressed, but not an admitted launch identity.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["postings-intersection", "sequence-diff", "weighted-coverage", "online-cache"];
const hash = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

for (const name of names) {
  const directory = join(root, `calibration-${name}`);
  const baseline = join(directory, "baseline");
  const gitDir = join(baseline, ".gitdir");
  if (!existsSync(gitDir)) {
    execFileSync("git", ["init", "--template=", "--initial-branch=baseline", `--separate-git-dir=${gitDir}`, baseline]);
    rmSync(join(baseline, ".git"));
  }
  const git = (args: string[]): string => execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${baseline}`, ...args], { encoding: "utf8" }).trim();
  git(["add", "task.py", "checker.py", "eval.py", "contract.json"]);
  let headExists = true;
  try { git(["rev-parse", "--verify", "HEAD"]); } catch { headExists = false; }
  if (!headExists || git(["diff", "--cached", "--name-only"]) !== "") {
    git(["commit", "-m", `Author fresh calibration-only ${name} baseline`]);
  }
  const config = JSON.parse(readFileSync(join(directory, "capsule.config.json"), "utf8"));
  const reportPath = join(directory, config.diagnosticOrdering.path);
  const report = DiagnosticOrderingReport.parse(JSON.parse(readFileSync(reportPath, "utf8")));
  const violations = validateDiagnosticOrdering({ ...report, failures: [] });
  report.failures = ["Offline cooperative observations only: not target-host isolated ordering or admission evidence.", ...violations];
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const contentHashes: Record<string, string> = {};
  for (const group of config.assetGroups) {
    for (const path of group.paths) contentHashes[path] = hash(readFileSync(join(directory, path)));
  }
  const candidate = {
    schemaVersion: 2,
    ...config,
    baseline: { kind: "git", commit: git(["rev-parse", "HEAD"]) },
    diagnosticOrdering: { path: config.diagnosticOrdering.path, hash: hash(readFileSync(reportPath)) },
    contentHashes,
  };
  const manifest = CapsuleManifest.parse({ ...candidate, id: deriveCapsuleId(candidate) });
  writeFileSync(join(directory, "manifest.draft.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${name}: ${manifest.id}; draft only; ${report.failures.length} admission prerequisites/violations`);
}
