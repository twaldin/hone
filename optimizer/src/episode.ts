import { z } from "zod";

/**
 * Role-driven coding-session request handed to the sealed in-sandbox worker.
 * The exact Pi/provider/proxy/session machinery is shared by every role; only
 * the prompt, safe tool subset, write envelope, and yielded schema vary.
 * worker/mutate.ts validates this shape without importing zod — keep in sync.
 */

export const EPISODE_CONTEXT_VERSION = 2;

export const CodingSessionRole = z.enum([
  "capsule-author",
  "evaluator-author",
  "adversarial-validator",
  "inner-improver",
  "outer-improver",
  "repair",
]);
export type CodingSessionRole = z.infer<typeof CodingSessionRole>;

export const CodingSessionTool = z.enum(["read", "bash", "write", "edit"]);
export type CodingSessionTool = z.infer<typeof CodingSessionTool>;

export const CodingSessionOutputSchema = z
  .object({
    type: z.literal("object"),
    additionalProperties: z.boolean(),
    required: z.array(z.string()).optional(),
    properties: z.record(z.unknown()),
  })
  .strict();
export type CodingSessionOutputSchema = z.infer<typeof CodingSessionOutputSchema>;

export const DEFAULT_MUTATE_OUTPUT_SCHEMA: CodingSessionOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "approach", "filesChanged"],
  properties: {
    summary: { type: "string", description: "What you changed and why, one paragraph." },
    approach: { type: "string", description: "Short strategy label for the lineage record." },
    filesChanged: { type: "array", items: { type: "string" }, description: "Paths you touched." },
  },
};

export const EpisodeContext = z.object({
  version: z.literal(EPISODE_CONTEXT_VERSION),
  episode: z.number().int().nonnegative(),
  mode: z.enum(["mutation", "repair"]),
  role: CodingSessionRole,
  systemPrompt: z.string().min(1),
  userPrompt: z.string().min(1),
  tools: z.array(CodingSessionTool).min(1),
  outputSchema: CodingSessionOutputSchema,
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
