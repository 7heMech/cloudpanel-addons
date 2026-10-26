function precedence(value: string): { core: number[]; pre: string[] } {
  const version = value.replace(/^v/, "").split("+")[0] ?? "";
  const hyphen = version.indexOf("-");
  const core = (hyphen < 0 ? version : version.slice(0, hyphen)).split(".").map((n) => parseInt(n, 10) || 0);
  return { core, pre: hyphen < 0 ? [] : version.slice(hyphen + 1).split(".") };
}

/**
 * Compare two semver strings (e.g. "0.9.4" and "0.9.3", or "v0.9.4" and "v0.9.3"),
 * pre-releases in semver's order: 2.0.0-rc.1 < 2.0.0-rc.2 < 2.0.0.
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = precedence(a);
  const pb = precedence(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numeric[0] && numeric[1]) return Number(x) - Number(y);
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
