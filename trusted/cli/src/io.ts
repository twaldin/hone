/** Command I/O boundary — commands never touch process.* directly so tests can run them in-process. */
export interface CmdIo {
  /** Working root: .hone-runs/ and .hone-cas/ live directly under it. */
  root: string;
  env: NodeJS.ProcessEnv;
  /** True only when both stdin and stdout are TTYs (interactive contract approval). */
  isTTY: boolean;
  out(line: string): void;
  err(line: string): void;
}

export function processIo(): CmdIo {
  return {
    root: process.cwd(),
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}
