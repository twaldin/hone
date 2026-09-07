/** Plain argv parsing — no CLI framework by design (trusted surface stays auditable). */

export class UsageError extends Error {}

export type Flags = Record<string, string | boolean>;

export interface FlagSpec {
  booleans?: string[];
  strings?: string[];
}

export function parseFlags(argv: string[], spec: FlagSpec = {}): { positionals: string[]; flags: Flags } {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let inline: string | undefined;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (booleans.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
    } else if (strings.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} requires a value`);
      flags[name] = value;
    } else {
      throw new UsageError(`unknown flag --${name}`);
    }
  }
  return { positionals, flags };
}

export function strFlag(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function boolFlag(flags: Flags, name: string): boolean {
  return flags[name] === true;
}
