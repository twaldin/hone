import { existsSync } from "node:fs";
import { join } from "node:path";
import { processIo } from "../../src/io.js";
import { runCommand } from "../../src/supervisor.js";

const mode = process.env["HONE_PENDING_OUTER_MODE"];
if (mode !== "start" && mode !== "resume") throw new Error("HONE_PENDING_OUTER_MODE must be start or resume");

const root = process.cwd();
const args = mode === "start"
  ? ["capsule", "--headless", "--backend", "./pending-child-backend.mjs"]
  : ["capsule", "--headless", "--resume"];

try {
  process.exitCode = await runCommand(args, processIo(), {
    hasUnsettledPendingChild: () => existsSync(join(root, "pending-child.authority")),
  });
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
