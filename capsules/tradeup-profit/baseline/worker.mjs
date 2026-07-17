#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const workspace = resolve(process.argv[2] ?? process.env.CAPSULE_WORKSPACE ?? "/workspace");
const policyModule = await import(pathToFileURL(resolve(workspace, "policy.mjs")).href);
if (typeof policyModule.solveCase !== "function") {
  throw new Error("policy.mjs must export solveCase(marketCase)");
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) continue;
  const request = JSON.parse(line);
  const result = await policyModule.solveCase(request.case);
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}
