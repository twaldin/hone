import { z } from "zod";

/**
 * The episode file handed to the in-sandbox worker at /scratch/episode.json.
 * Prompts are rendered HOST-SIDE by assets/context.ts so the worker stays a
 * single self-contained bundle; worker/mutate.ts validates this shape with
 * hand-rolled checks (the bundled worker never imports this module) — keep
 * the two in sync.
 */

export const EPISODE_CONTEXT_VERSION = 1;

export const EpisodeContext = z.object({
  version: z.literal(EPISODE_CONTEXT_VERSION),
  episode: z.number().int().nonnegative(),
  mode: z.enum(["mutation", "repair"]),
  systemPrompt: z.string().min(1),
  userPrompt: z.string().min(1),
});
export type EpisodeContext = z.infer<typeof EpisodeContext>;

/** Path inside the mutation sandbox where the loop putFile's the episode context. */
export const EPISODE_JSON_PATH = "/scratch/episode.json";

/** Structured result the worker prints as the LAST stdout line on success. */
export const MutateResult = z.object({
  summary: z.string(),
  approach: z.string(),
  filesChanged: z.array(z.string()),
});
export type MutateResult = z.infer<typeof MutateResult>;

/** Parse the worker's stdout: the last non-empty line must be a MutateResult. */
export function parseMutateStdout(stdout: string): MutateResult | null {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  try {
    const parsed = MutateResult.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
