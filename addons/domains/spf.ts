import { isIP } from "node:net";
import { recordName } from "./model";

interface Term { text: string; key: string }
interface Spf { mechanisms: Term[]; all?: Term; modifiers: Map<string, Term> }

export function mergeSpf(required: string[], existing: string[], name: string): string {
  function fail(detail: string): never { throw new Error(`SPF at ${name}: ${detail}; review the SPF in DNS before enforcing`); }
  const host = (value: string): string => {
    const normalized = value.toLowerCase().replace(/\.$/, "");
    if (!recordName(normalized) || normalized.startsWith("*.")) fail("invalid or unsupported domain specification");
    return normalized;
  };
  const parse = (value: string): Spf => {
    if (/[^\x20-\x7e]/.test(value) || !/^v=spf1(?: |$)/i.test(value)) fail("malformed record");
    if (value.includes("%")) fail("macro expressions need a manual merge");
    const result: Spf = { mechanisms: [], modifiers: new Map() };
    for (const text of value.replace(/ +$/, "").split(/ +/).slice(1)) {
      const modifier = /^([a-z][a-z\d_.-]*)=(.*)$/i.exec(text);
      if (modifier) {
        const key = modifier[1]!.toLowerCase(), value = modifier[2]!;
        if (result.modifiers.has(key)) fail("repeated modifier");
        result.modifiers.set(key, { text, key: ["redirect", "exp"].includes(key) ? host(value) : value });
        continue;
      }
      const mechanism = /^([+?~-]?)(all|include|a|mx|ptr|ip4|ip6|exists)(.*)$/i.exec(text);
      if (!mechanism) fail("invalid or unsupported mechanism");
      const qualifier = mechanism[1] || "+", kind = mechanism[2]!.toLowerCase(), rest = mechanism[3]!;
      if (result.all) fail("mechanisms after all need a manual merge");
      if (kind === "all") {
        if (rest) fail("malformed all mechanism");
        result.all = { text, key: qualifier };
        continue;
      }
      if (qualifier !== "+") fail("non-pass mechanisms need a manual merge");
      let key: string;
      if (kind === "ip4" || kind === "ip6") {
        const ip = /^:([^/]+)(?:\/(0|[1-9]\d{0,2}))?$/.exec(rest), family = kind === "ip4" ? 4 : 6, bits = family === 4 ? 32 : 128;
        if (!ip || isIP(ip[1]!) !== family || Number(ip[2] ?? bits) > bits) fail("invalid IP mechanism");
        key = `${kind}:${family === 4 ? ip[1] : new URL(`http://[${ip[1]}]/`).hostname}/${Number(ip[2] ?? bits)}`;
      } else if (kind === "a" || kind === "mx") {
        const address = /^(?::([^/]+))?(?:\/(0|[1-9]\d?))?(?:\/\/(0|[1-9]\d{0,2}))?$/.exec(rest);
        if (!address || Number(address[2] ?? 32) > 32 || Number(address[3] ?? 128) > 128) fail("invalid address mechanism");
        key = `${kind}:${address[1] ? host(address[1]) : ""}/${Number(address[2] ?? 32)}//${Number(address[3] ?? 128)}`;
      } else {
        if (kind === "ptr" && !rest) key = kind;
        else {
          if (!rest.startsWith(":")) fail("missing mechanism domain");
          key = `${kind}:${host(rest.slice(1))}`;
        }
      }
      result.mechanisms.push({ text, key });
    }
    return result;
  };
  const configured = parse(["v=spf1", ...required, "~all"].join(" "));
  const policies = [...new Set(existing)].sort().map(parse);
  if (!policies.length) return ["v=spf1", ...new Map(configured.mechanisms.map((t) => [t.key, t.text])).values(), "~all"].join(" ");
  const signature = (p: Spf) => JSON.stringify([p.all?.key ?? null, [...p.modifiers].map(([key, term]) => [key, term.key]).sort()]);
  if (policies.some((p) => signature(p) !== signature(policies[0]!))) fail("multiple records have conflicting ending policies or modifiers");
  const terms = new Map<string, string>();
  for (const p of [...policies, configured]) for (const t of p.mechanisms) if (!terms.has(t.key)) terms.set(t.key, t.text);
  const first = policies[0]!;
  return ["v=spf1", ...terms.values(), ...(first.all ? [first.all.text] : []), ...[...first.modifiers.values()].map((t) => t.text)].join(" ");
}
