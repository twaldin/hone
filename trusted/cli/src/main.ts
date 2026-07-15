import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { UsageError } from "./args.js";
import { applyCommand } from "./commands/apply.js";
import { bestCommand } from "./commands/best.js";
import { diffCommand } from "./commands/diff.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { LadderLockedError } from "./deliver.js";
import { processIo } from "./io.js";
import type { CmdIo } from "./io.js";
import { runCommand } from "./supervisor.js";

const USAGE = `hone — trusted run supervisor + anytime surface

usage:
  hone run <capsule-dir> [--headless] [--budget-usd N] [--apply none|branch|pr|auto] [--resume]
           [--backend stub|local|<module>] [--config <json>]
  hone status [--run ID]
  hone best [--run ID]
  hone diff [--stat] [--run ID]
  hone apply --best [--branch NAME] [--run ID] [--repo DIR]
  hone stop [--take-best] [--run ID] [--repo DIR]

exit codes: 0 ok · 1 error/declined · 2 usage · 3 autonomy-ladder refusal`;

export async function main(argv: string[], io: CmdIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run":
        return await runCommand(rest, io);
      case "status":
        return await statusCommand(rest, io);
      case "best":
        return await bestCommand(rest, io);
      case "diff":
        return await diffCommand(rest, io);
      case "apply":
        return await applyCommand(rest, io);
      case "stop":
        return await stopCommand(rest, io);
      case undefined:
      case "help":
      case "--help":
        io.out(USAGE);
        return command === undefined ? 2 : 0;
      default:
        io.err(`unknown command: ${command}`);
        io.err(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 2;
    }
    if (e instanceof LadderLockedError) {
      io.err(e.message);
      return 3;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

const invoked = process.argv[1] !== undefined ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url || invoked.endsWith("/bin/hone.js")) {
  process.exitCode = await main(process.argv.slice(2), processIo());
}
