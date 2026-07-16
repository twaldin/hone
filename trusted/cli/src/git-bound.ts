/**
 * One hard wall-clock bound shared by EVERY synchronous trusted Git helper
 * (deliver, delivery-target validation probes, git-baseline plumbing, diff
 * preview). Git invocations here are local-only but their INPUTS are hostile
 * (target-repo objects/config, PATH-resolved binaries): a FIFO-backed config
 * file, a wedged filesystem, or a sleeping shim must fail the operation
 * closed within the bound instead of hanging the supervisor forever. On
 * expiry the child is SIGKILLed by spawnSync/execFileSync itself — no
 * surviving process, no ref moved, no event emitted. The interactive
 * contract editor is deliberately NOT routed through this bound.
 */
const GIT_TIMEOUT_MS_DEFAULT = 60_000;

export function gitTimeoutMs(): number {
  const raw = Number(process.env["HONE_GIT_TIMEOUT_MS"] ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return GIT_TIMEOUT_MS_DEFAULT;
  return Math.min(raw, 3_600_000);
}

/** Uniform fail-closed diagnostic for a bounded git call that hit the wall. */
export function gitTimeoutError(what: string, timeout: number): Error {
  return new Error(
    `${what} exceeded the ${timeout}ms bound and was SIGKILLed — wedged or hostile git invocation; failing closed with no ref moved`,
  );
}
