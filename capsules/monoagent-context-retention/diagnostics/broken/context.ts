import type { RetentionInput } from "./contract.ts";

/** Intentionally violates the protected-current and contract-version gates. */
export function assemble(input: RetentionInput): string {
  return JSON.stringify({
    version: 0,
    current: { ...input.current, content: "" },
    records: [],
  });
}
