import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assessPromotion, PromotionGateCalibration } from "@hone/schema";
import { episodeRand } from "./loop.js";

export const PilotPolicyRequest = z.object({
  seed: z.number().int(),
  episode: z.number().int().nonnegative(),
  parentScore: z.number().finite(),
  childScore: z.number().finite(),
  calibration: PromotionGateCalibration,
}).strict();

export function pilotPolicy(input: unknown) {
  const request = PilotPolicyRequest.parse(input);
  const draw = episodeRand(request.seed, request.episode);
  return {
    parent: draw < 0.1 ? "seed" as const : "incumbent" as const,
    draw,
    epsilon: 0.1,
    gate: assessPromotion(request.parentScore, request.childScore, request.calibration),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(pilotPolicy(JSON.parse(readFileSync(0, "utf8"))))}\n`);
}
