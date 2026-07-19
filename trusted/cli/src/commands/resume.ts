import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CampaignPauseSignal, CampaignResumeSignal, type CampaignPauseSignal as CampaignPauseSignalRecord } from "@hone/schema";
import { z } from "zod";
import { UsageError, parseFlags, strFlag } from "../args.js";
import type { CmdIo } from "../io.js";
import { runsRoot } from "../runs.js";
import { coordinateCampaignResume, type CampaignResumeCoordinatorOptions } from "./hone.js";

const RESUME_USAGE = "usage: hone resume [--pause PAUSE_ID] [--campaign CAMPAIGN_STATE_DIR]";
const CAMPAIGN_PAUSE_FILE = "campaign-pause.v1.json";

const PauseFile = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().default(0),
  configHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  active: z.array(CampaignPauseSignal),
  resumed: z.array(CampaignResumeSignal),
}).strict();

export interface ActiveCampaignPause {
  readonly campaignDir: string;
  readonly authorityPath: string;
  readonly pause: CampaignPauseSignalRecord;
}

function pauseFilesUnder(root: string): string[] {
  const base = runsRoot(root);
  if (!existsSync(base)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(base)) {
    const candidate = join(base, entry, CAMPAIGN_PAUSE_FILE);
    if (existsSync(candidate) && statSync(candidate).isFile()) paths.push(candidate);
  }
  return paths.sort();
}

/** Read-only campaign pause discovery shared by status and resume. */
export function activeCampaignPauses(root: string): ActiveCampaignPause[] {
  const active: ActiveCampaignPause[] = [];
  for (const authorityPath of pauseFilesUnder(root)) {
    const state = PauseFile.parse(JSON.parse(readFileSync(authorityPath, "utf8")));
    for (const pause of state.active) active.push({ campaignDir: dirname(authorityPath), authorityPath, pause });
  }
  return active.sort((left, right) => {
    const byTime = left.pause.at.localeCompare(right.pause.at);
    return byTime !== 0 ? byTime : left.pause.pauseId.localeCompare(right.pause.pauseId);
  });
}

export type TrustedCampaignResumeOptions = CampaignResumeCoordinatorOptions;

function campaignDirectory(flag: string, root: string): string {
  const candidate = resolve(root, flag);
  if (!existsSync(candidate)) throw new UsageError(`unknown campaign state path ${candidate}`);
  return statSync(candidate).isDirectory() ? candidate : dirname(candidate);
}

export async function resumeCampaignCommand(
  args: string[],
  io: CmdIo,
  trusted: TrustedCampaignResumeOptions = {},
): Promise<number> {
  const { positionals, flags } = parseFlags(args, { strings: ["pause", "campaign"] });
  if (positionals.length !== 0) throw new UsageError(RESUME_USAGE);
  const pauseFlag = strFlag(flags, "pause");
  const campaignFlag = strFlag(flags, "campaign");
  const selectedCampaignDir = campaignFlag === undefined ? undefined : campaignDirectory(campaignFlag, io.root);
  const matches = activeCampaignPauses(io.root).filter((entry) =>
    (pauseFlag === undefined || entry.pause.pauseId === pauseFlag)
    && (selectedCampaignDir === undefined || entry.campaignDir === selectedCampaignDir)
  );
  if (matches.length === 0) throw new UsageError("no active durable campaign pause matches this resume request");
  if (matches.length > 1) {
    throw new UsageError("multiple active campaign pauses match; select one with --pause PAUSE_ID or --campaign CAMPAIGN_STATE_DIR");
  }
  const selected = matches[0];
  if (selected === undefined) throw new UsageError("no active durable campaign pause matches this resume request");

  const { pause, preflight } = await coordinateCampaignResume({
    authorityPath: selected.authorityPath,
    pauseId: selected.pause.pauseId,
    root: io.root,
    env: io.env,
  }, trusted);
  if (!preflight.passed) {
    io.err(`campaign remains paused: frozen-route preflight failed for ${pause.pauseId}`);
    for (const observation of preflight.observations) {
      io.err(`${observation.role}: requested=${observation.requestedRoute} returned=${observation.returnedModel ?? "(none)"} status=${observation.status ?? "(none)"}`);
    }
    return 1;
  }
  io.out(`campaign resumed: ${pause.pauseId}`);
  return 0;
}
