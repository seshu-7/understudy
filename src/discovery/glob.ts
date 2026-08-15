/**
 * The minimal glob this project needs: `**` for any number of path segments,
 * `*` for one segment's worth of characters. Enough to write
 * "/servicing/**" and "/servicing/**\/delete" in a policy file without a
 * dependency for something this small.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else {
      out += c!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

export function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(value));
}
