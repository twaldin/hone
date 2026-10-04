import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveUpstreamConfig, upstreamEndpoint } from "../src/index.js";

async function tokenFile(contents: string, mode: number): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "hone-upstream-")), "upstream.token");
  await writeFile(path, contents);
  await chmod(path, mode);
  return path;
}

describe("upstream configuration", () => {
  it("requires an explicit http(s) base URL", () => {
    expect(() => resolveUpstreamConfig({})).toThrow(/HONE_UPSTREAM_BASE_URL is required/);
    expect(() => resolveUpstreamConfig({ HONE_UPSTREAM_BASE_URL: "  " })).toThrow(/is required/);
    expect(() => resolveUpstreamConfig({ HONE_UPSTREAM_BASE_URL: "twaldin-home:4000" })).toThrow(/http\(s\)/);
  });

  it("reads the bearer from a private token file without its trailing newline", async () => {
    const path = await tokenFile("tok_abc123\n", 0o600);
    expect(resolveUpstreamConfig({
      HONE_UPSTREAM_BASE_URL: "http://twaldin-home:4000/v1",
      HONE_UPSTREAM_API_KEY_FILE: path,
    })).toEqual({ upstreamBaseUrl: "http://twaldin-home:4000/v1", upstreamApiKey: "tok_abc123" });
  });

  it("refuses a token file readable by group or others, and an empty one", async () => {
    const shared = await tokenFile("tok_abc123\n", 0o640);
    expect(() => resolveUpstreamConfig({
      HONE_UPSTREAM_BASE_URL: "http://gateway:4000",
      HONE_UPSTREAM_API_KEY_FILE: shared,
    })).toThrow(/chmod 600/);
    const empty = await tokenFile("\n", 0o600);
    expect(() => resolveUpstreamConfig({
      HONE_UPSTREAM_BASE_URL: "http://gateway:4000",
      HONE_UPSTREAM_API_KEY_FILE: empty,
    })).toThrow(/is empty/);
  });

  it("accepts an inline key, refuses both sources, and allows no key", async () => {
    expect(resolveUpstreamConfig({ HONE_UPSTREAM_BASE_URL: "http://gateway:4000", HONE_UPSTREAM_API_KEY: "k" }))
      .toEqual({ upstreamBaseUrl: "http://gateway:4000", upstreamApiKey: "k" });
    expect(() => resolveUpstreamConfig({
      HONE_UPSTREAM_BASE_URL: "http://gateway:4000",
      HONE_UPSTREAM_API_KEY: "k",
      HONE_UPSTREAM_API_KEY_FILE: "/dev/null",
    })).toThrow(/only one/);
    expect(resolveUpstreamConfig({ HONE_UPSTREAM_BASE_URL: "http://gateway:4000" }))
      .toEqual({ upstreamBaseUrl: "http://gateway:4000" });
  });

  it("joins endpoints whether or not the base URL carries /v1", () => {
    for (const base of ["http://gateway:4000", "http://gateway:4000/", "http://gateway:4000/v1", "http://gateway:4000/v1/"]) {
      expect(upstreamEndpoint(base, "chat/completions").href).toBe("http://gateway:4000/v1/chat/completions");
    }
    expect(upstreamEndpoint("https://host/proxy/v1", "models").href).toBe("https://host/proxy/v1/models");
  });
});
