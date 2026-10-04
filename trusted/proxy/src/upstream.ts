import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

/**
 * Operator-side upstream selection. Sandboxes never see any of this: the
 * proxy holds the URL and bearer and injects them on the way out.
 *
 * - `HONE_UPSTREAM_BASE_URL` (required): OpenAI-compatible base URL, with or
 *   without a trailing `/v1` (`http://twaldin-home:4000/v1`).
 * - `HONE_UPSTREAM_API_KEY_FILE` (preferred) or `HONE_UPSTREAM_API_KEY`:
 *   bearer token. The file must not be readable by group or others; it is
 *   read once and its surrounding whitespace dropped. Setting both refuses.
 */
export const UPSTREAM_BASE_URL_ENV = "HONE_UPSTREAM_BASE_URL";
export const UPSTREAM_API_KEY_ENV = "HONE_UPSTREAM_API_KEY";
export const UPSTREAM_API_KEY_FILE_ENV = "HONE_UPSTREAM_API_KEY_FILE";

export interface UpstreamConfig {
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
}

/** Thrown for a missing or unusable upstream configuration. */
export class UpstreamConfigError extends Error {
  override readonly name = "UpstreamConfigError";
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** Resolve the upstream URL and bearer from the operator's environment. */
export function resolveUpstreamConfig(env: NodeJS.ProcessEnv): UpstreamConfig {
  const baseUrl = nonEmpty(env[UPSTREAM_BASE_URL_ENV])?.trim();
  if (baseUrl === undefined) {
    throw new UpstreamConfigError(
      `${UPSTREAM_BASE_URL_ENV} is required: set it to the OpenAI-compatible model gateway (e.g. http://twaldin-home:4000/v1)`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new UpstreamConfigError(`${UPSTREAM_BASE_URL_ENV} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UpstreamConfigError(`${UPSTREAM_BASE_URL_ENV} must be an http(s) URL`);
  }
  const inlineKey = nonEmpty(env[UPSTREAM_API_KEY_ENV]);
  const keyFile = nonEmpty(env[UPSTREAM_API_KEY_FILE_ENV]);
  if (inlineKey !== undefined && keyFile !== undefined) {
    throw new UpstreamConfigError(`set only one of ${UPSTREAM_API_KEY_ENV} and ${UPSTREAM_API_KEY_FILE_ENV}`);
  }
  const apiKey = keyFile === undefined ? inlineKey?.trim() : readTokenFile(keyFile);
  return apiKey === undefined ? { upstreamBaseUrl: baseUrl } : { upstreamBaseUrl: baseUrl, upstreamApiKey: apiKey };
}

function readTokenFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    throw new UpstreamConfigError(
      `${UPSTREAM_API_KEY_FILE_ENV} cannot be opened (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new UpstreamConfigError(`${UPSTREAM_API_KEY_FILE_ENV} must name a regular file`);
    if ((stat.mode & 0o077) !== 0) {
      throw new UpstreamConfigError(
        `${UPSTREAM_API_KEY_FILE_ENV} is readable by group or others (mode ${(stat.mode & 0o777).toString(8)}); chmod 600 it`,
      );
    }
    const token = readFileSync(fd, "utf8").trim();
    if (token === "") throw new UpstreamConfigError(`${UPSTREAM_API_KEY_FILE_ENV} is empty`);
    if (/\s/.test(token)) throw new UpstreamConfigError(`${UPSTREAM_API_KEY_FILE_ENV} must hold exactly one bearer token`);
    return token;
  } finally {
    closeSync(fd);
  }
}

/**
 * `<base>/v1/<path>` for a base URL given with or without its `/v1` suffix
 * (and with any path prefix in front of it preserved).
 */
export function upstreamEndpoint(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.pathname = `${prefix}/v1/${path}`;
  url.search = "";
  url.hash = "";
  return url;
}
