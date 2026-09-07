import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { collectTsconfigClosure, trustedRuntimeDigest } from "../src/supervisor.js";
import { makeRoot, pkgRoot } from "./helpers.js";

/**
 * Trusted-runtime seal must cover the ACTUAL tsx loader configuration
 * (release gate P1): tsconfig files steer which bytes a trusted import
 * loads, so the digest seals the whole consulted tsconfig/extends closure,
 * any mapping escaping the trusted workspace refuses, and the production
 * entry (bin/hone.js) pins the loader to package resolution only —
 * ambient/caller tsconfigs are structurally ignored.
 */

const repoRoot = join(pkgRoot, "..", "..");

describe("collectTsconfigClosure — real workspace", () => {
  it("includes the repo-root base tsconfig and every trusted package tsconfig", () => {
    const packageRoots = ["cli", "broker", "proxy", "scoring"].map((p) => join(repoRoot, "trusted", p));
    packageRoots.push(join(repoRoot, "schema"));
    const rels = collectTsconfigClosure(repoRoot, packageRoots).map((f) => f.rel);
    expect(rels).toContain("tsconfig.base.json");
    expect(rels).toContain(join("trusted", "cli", "tsconfig.json"));
    expect(rels).toContain(join("schema", "tsconfig.json"));
    // deterministic ordering (digest input stability)
    expect(rels).toEqual([...rels].sort());
  });
});

describe("collectTsconfigClosure — hostile fixtures (fail closed)", () => {
  function scratchWorkspace(): { work: string; pkg: string } {
    const work = makeRoot();
    const pkg = join(work, "pkg");
    mkdirSync(pkg, { recursive: true });
    return { work, pkg };
  }

  it("follows a benign relative extends chain and seals every file in it", () => {
    const { work, pkg } = scratchWorkspace();
    writeFileSync(join(work, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({ extends: "../tsconfig.base.json" }));
    const rels = collectTsconfigClosure(work, [pkg]).map((f) => f.rel);
    expect(rels).toEqual([join("pkg", "tsconfig.json"), "tsconfig.base.json"]);
  });

  it("rejects a package-resolved (node_modules) extends base", () => {
    const { work, pkg } = scratchWorkspace();
    writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({ extends: "@evil/tsconfig" }));
    expect(() => collectTsconfigClosure(work, [pkg])).toThrow(/escape the trusted workspace closure/);
  });

  it("rejects an extends target resolving OUTSIDE the trusted closure", () => {
    const { work, pkg } = scratchWorkspace();
    const outside = makeRoot();
    writeFileSync(join(outside, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    // a RELATIVE extends that walks out of the workspace entirely
    writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({ extends: relative(pkg, join(outside, "tsconfig.json")) }));
    expect(() => collectTsconfigClosure(work, [pkg])).toThrow(/escapes the trusted workspace closure/);
  });

  it("rejects a paths mapping that redirects imports outside the trusted closure", () => {
    const { work, pkg } = scratchWorkspace();
    writeFileSync(
      join(pkg, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@hone/schema": ["/tmp/evil.ts"], "@hone/schema/*": ["/tmp/evil/*"] } } }),
    );
    expect(() => collectTsconfigClosure(work, [pkg])).toThrow(/escaping the trusted workspace closure/);
  });

  it("rejects a baseUrl outside the trusted closure; accepts in-package mappings", () => {
    const { work, pkg } = scratchWorkspace();
    writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "../.." } }));
    expect(() => collectTsconfigClosure(work, [pkg])).toThrow(/baseUrl .* outside the trusted workspace closure/);
    writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "#local/*": ["./src/*"] } } }));
    expect(collectTsconfigClosure(work, [pkg]).map((f) => f.rel)).toEqual([join("pkg", "tsconfig.json")]);
  });

  it("rejects an unparseable tsconfig instead of silently skipping it", () => {
    const { work, pkg } = scratchWorkspace();
    writeFileSync(join(pkg, "tsconfig.json"), "{ not json");
    expect(() => collectTsconfigClosure(work, [pkg])).toThrow(/not valid JSON/);
  });
});

describe("trustedRuntimeDigest seals the tsconfig closure", () => {
  it("is deterministic, and drifts when a closure tsconfig changes byte-for-byte", () => {
    const before = trustedRuntimeDigest();
    expect(before).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(trustedRuntimeDigest()).toBe(before);
    const basePath = join(repoRoot, "tsconfig.base.json");
    const original = readFileSync(basePath);
    writeFileSync(basePath, Buffer.concat([original, Buffer.from("\n")]));
    try {
      expect(trustedRuntimeDigest()).not.toBe(before);
    } finally {
      writeFileSync(basePath, original);
    }
    expect(trustedRuntimeDigest()).toBe(before);
  });
});

describe("sealed ESM resolution is root-confined", () => {
  it("blocks a dependency-confusion package found by normal ancestor lookup outside the seal", () => {
    const root = makeRoot();
    const packageDir = join(root, "node_modules", "pwn");
    const marker = join(root, "pwned");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "pwn", type: "module", exports: "./index.js" }));
    writeFileSync(join(packageDir, "index.js"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "pwned\\n");`);

    const positivePath = join(root, "positive.mjs");
    writeFileSync(positivePath, 'import "pwn";\n');
    const positive = spawnSync(process.execPath, [positivePath], { encoding: "utf8", timeout: 120_000 });
    expect(positive.status, positive.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("pwned\n");
    rmSync(marker);

    const helperUrl = pathToFileURL(join(pkgRoot, "src", "runtime-digest.js")).href;
    const guardedPath = join(root, "guarded.mjs");
    writeFileSync(
      guardedPath,
      `import { register } from "node:module";
       import { rmSync } from "node:fs";
       import { sealRuntimeSnapshot } from ${JSON.stringify(helperUrl)};
       const seal = sealRuntimeSnapshot();
       register(seal.loaderUrl, import.meta.url, {
         data: { root: seal.root, allowedDataUrl: "data:text/javascript,export{}" },
       });
       try {
         // Intentional dynamic import: this regression exercises the runtime-selected ESM boundary.
         await import("pwn");
         rmSync(seal.root, { recursive: true, force: true });
         process.exit(90);
       } catch (error) {
         console.error(error instanceof Error ? error.message : String(error));
         rmSync(seal.root, { recursive: true, force: true });
       }\n`,
    );
    const guarded = spawnSync(process.execPath, [guardedPath], { encoding: "utf8", timeout: 120_000 });
    expect(guarded.status, guarded.stderr).toBe(0);
    expect(guarded.stderr).toContain("resolved outside the sealed snapshot");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("bin/hone.js pins the tsx loader to package resolution only (executable, hostile mapping)", () => {
  function hostileDir(): string {
    const dir = makeRoot();
    writeFileSync(join(dir, "evil.ts"), 'console.error("PWNED-BY-TSCONFIG");\nprocess.exit(99);\n');
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@hone/schema": ["./evil.ts"], "@hone/schema/*": ["./evil.ts"] } } }),
    );
    return dir;
  }

  it("an ambient cwd tsconfig cannot remap trusted imports through the real bin entry", () => {
    const dir = hostileDir();
    const r = spawnSync(process.execPath, [join(pkgRoot, "bin", "hone.js"), "help"], { encoding: "utf8", cwd: dir, timeout: 120_000 });
    expect(r.stderr).not.toContain("PWNED-BY-TSCONFIG");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("trusted run supervisor");
  });

  it("TSX_TSCONFIG_PATH is ignored by the real bin entry", () => {
    const dir = hostileDir();
    const r = spawnSync(process.execPath, [join(pkgRoot, "bin", "hone.js"), "help"], {
      encoding: "utf8",
      cwd: dir,
      timeout: 120_000,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(dir, "tsconfig.json") },
    });
    expect(r.stderr).not.toContain("PWNED-BY-TSCONFIG");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("trusted run supervisor");
  });

  it("POSITIVE CONTROL: the same mapping IS potent against an unpinned tsx loader", () => {
    const dir = hostileDir();
    // Raw `tsx` CLI (no tsconfig:false pin) honors the caller's config: the
    // bare specifier @hone/schema resolves into the hostile mapping.
    const r = spawnSync(join(pkgRoot, "node_modules", ".bin", "tsx"), [join(pkgRoot, "src", "main.ts"), "help"], {
      encoding: "utf8",
      cwd: dir,
      timeout: 120_000,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(dir, "tsconfig.json") },
    });
    const observable = `${r.stdout}\n${r.stderr}`;
    // Either the evil module executed, or instantiation failed because the
    // import was remapped to it — both prove the redirect happened.
    expect(r.status).not.toBe(0);
    expect(observable).toMatch(/PWNED-BY-TSCONFIG|does not provide an export named/);
  });
});
