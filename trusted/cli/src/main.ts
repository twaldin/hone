import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { UsageError } from "./args.js";
import { applyCommand } from "./commands/apply.js";
import { authorCommand } from "./commands/author.js";
import { bestCommand } from "./commands/best.js";
import { diffCommand } from "./commands/diff.js";
import { honeCommand, recursiveCommand } from "./commands/hone.js";
import { resumeCampaignCommand } from "./commands/resume.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { LadderLockedError } from "./deliver.js";
import { processIo } from "./io.js";
import type { CmdIo } from "./io.js";
import { runCommand } from "./supervisor.js";

const USAGE = `hone — trusted run supervisor + anytime surface

usage:
  hone "<objective>" [author/run flags]
  hone run <capsule-dir> [--headless] [--budget-usd N] [--apply none|branch|pr|auto] [--repo <dir>] [--resume]
           [--backend stub|local] [--config <json>]
  hone author <capsule-objective> [--repo DIR] [--headless] [--acknowledge-dirty]
  hone hone --campaign <path> --headless
  hone recursive --campaign <path> --headless [--phase freeze|search|confirmation|terminal]
  hone resume [--pause PAUSE_ID] [--campaign CAMPAIGN_STATE_DIR]
  hone status [--run ID]
  hone best [--run ID]
  hone diff [--stat] [--run ID]
  hone apply --best --repo DIR [--branch NAME] [--run ID]
  hone stop [--take-best --repo DIR] [--run ID]
  hone off [--run ID]

exit codes: 0 ok · 1 error/declined · 2 usage · 3 autonomy-ladder refusal`;

export function classifyBareObjective(objective: string, root: string): "run" | "author" {
  return existsSync(resolve(root, objective, "manifest.json")) ? "run" : "author";
}

export async function main(argv: string[], io: CmdIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run":
        return await runCommand(rest, io);
      case "author":
        return await authorCommand(rest, io);
      case "hone":
        return await honeCommand(rest, io);
      case "recursive":
        return await recursiveCommand(rest, io);
      case "resume":
        return await resumeCampaignCommand(rest, io);
      case "status":
        return await statusCommand(rest, io);
      case "best":
        return await bestCommand(rest, io);
      case "diff":
        return await diffCommand(rest, io);
      case "apply":
        return await applyCommand(rest, io);
      case "stop":
      case "off":
        return await stopCommand(rest, io);
      case undefined:
      case "help":
      case "--help":
        io.out(USAGE);
        return command === undefined ? 2 : 0;
      default:
        if (command.startsWith("-")) {
          io.err(`unknown command: ${command}`);
          io.err(USAGE);
          return 2;
        }
        return classifyBareObjective(command, io.root) === "run"
          ? await runCommand([command, ...rest], io)
          : await authorCommand([command, ...rest], io);
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
