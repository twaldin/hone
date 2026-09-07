// Minimal glob → RegExp for protected-path matching. Supported syntax:
//   `**`                — any number of characters, across `/`
//   `**` before a `/`   — zero or more leading path segments
//   `*`                 — any characters within one segment
//   `?`                 — one character within one segment
// Everything else is literal. Deliberately dependency-free: protected-path
// enforcement is trusted-kernel code and must be auditable at a glance.
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c !== undefined) {
      out += /[\\^$.|+()[\]{}]/.test(c) ? `\\${c}` : c;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAnyGlob(relPath: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(relPath));
}
