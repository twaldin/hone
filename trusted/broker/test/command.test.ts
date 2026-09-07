import { describe, expect, it } from "vitest";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/command.js";
import { deferred } from "../src/deferred.js";

// ---------------------------------------------------------------------------
// stdinFile source errors: createReadStream previously had no error listener,
// so an ENOENT/EACCES race (e.g. the scratch snapshot vanishing mid-restore)
// emitted an unhandled 'error' event and crashed the whole broker process.
// The command promise must reject and the child must be torn down instead.
// ---------------------------------------------------------------------------

describe("runCommand stdinFile source errors", () => {
  it("rejects with a named error (instead of crashing the process) when the stdin file is missing", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-cmd-"));
    const missing = path.join(base, "does-not-exist.tar");
    await expect(runCommand(["cat"], { stdinFile: missing })).rejects.toThrow(
      /stdin file .*does-not-exist\.tar/,
    );
  });

  it("tears the child process group down when the stdin source fails", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-cmd-"));
    const marker = path.join(base, "alive");
    // The child ignores stdin entirely and would create the marker after a
    // real-time delay if it survived. Absence-after-kill is inherently a
    // platform-clock property (SIGKILL cannot be faked with test timers), so
    // this test waits out the child's own schedule once — the only wall-clock
    // wait in the suite.
    const command = runCommand(["sh", "-c", `sleep 0.4; : > "${marker}"`], {
      stdinFile: path.join(base, "missing"),
    });
    await expect(command).rejects.toThrow(/stdin file/);
    const { promise, resolve } = deferred<void>();
    setTimeout(resolve, 800);
    await promise;
    await expect(stat(marker)).rejects.toThrow(); // SIGKILLed group — the marker never appears
  });

  it("still streams an existing stdin file to the child", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-cmd-"));
    const payload = path.join(base, "payload.bin");
    await writeFile(payload, "snapshot-bytes");
    const res = await runCommand(["cat"], { stdinFile: payload });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString("utf8")).toBe("snapshot-bytes");
  });
});
