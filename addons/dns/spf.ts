/**
 * Merging a profile's SPF into the SPF a domain already publishes.
 *
 * The existing record keeps its senders, their order and how it ends (`all`,
 * `redirect=`, or nothing); the profile adds whatever senders it needs that
 * are not already there. What cannot be merged safely is reported instead of
 * rewritten. See RFC 7208.
 */
import { isIP } from "node:net";
import { dnsName } from "./model";

export function isSpf(text: string): boolean {
  return /^v=spf1(?:\s|$)/i.test(text);
}

interface Term {
  /** As written, so a merged record keeps the operator's spelling. */
  text: string;
  /** What makes two terms the same sender. */
  key: string;
}

interface ParsedSpf {
  mechanisms: Term[];
  all: Term | null;
  modifiers: Term[];
}

export type SpfMerge =
  | { ok: true; value: string; changed: boolean }
  | { ok: false; problem: string };

const LOOKUP_MECHANISMS = new Set(["include", "a", "mx", "ptr", "exists"]);
const MAX_LOOKUPS = 10;

class SpfProblem extends Error {}

function domainSpec(value: string): string {
  const name = value.toLowerCase().replace(/\.$/, "");
  if (!dnsName(name) || name.startsWith("*.")) throw new SpfProblem(`"${value}" is not a domain`);
  return name;
}

function addressKey(kind: "ip4" | "ip6", rest: string): string {
  const match = /^:([^/]+)(?:\/(\d{1,3}))?$/.exec(rest);
  const family = kind === "ip4" ? 4 : 6;
  const bits = Number(match?.[2] ?? (family === 4 ? 32 : 128));
  if (!match || isIP(match[1]!) !== family || bits > (family === 4 ? 32 : 128)) throw new SpfProblem(`"${kind}${rest}" is not an address`);
  const address = family === 4 ? match[1]! : new URL(`http://[${match[1]}]/`).hostname.slice(1, -1);
  return `${kind}:${address}/${bits}`;
}

function hostKey(kind: string, rest: string): string {
  const match = /^(?::([^/]+))?(?:\/(\d{1,2}))?(?:\/\/(\d{1,3}))?$/.exec(rest);
  if (!match) throw new SpfProblem(`"${kind}${rest}" is malformed`);
  const target = match[1] ? domainSpec(match[1]) : "";
  return `${kind}:${target}/${match[2] ?? 32}//${match[3] ?? 128}`;
}

function parse(record: string): ParsedSpf {
  if (record.includes("%")) throw new SpfProblem("it uses macros");
  const parsed: ParsedSpf = { mechanisms: [], all: null, modifiers: [] };
  for (const text of record.trim().split(/\s+/).slice(1)) {
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(text);
    if (modifier) {
      const name = modifier[1]!.toLowerCase();
      if (parsed.modifiers.some((term) => term.key.startsWith(`${name}=`))) throw new SpfProblem(`it repeats ${name}=`);
      const value = name === "redirect" || name === "exp" ? domainSpec(modifier[2]!) : modifier[2]!;
      parsed.modifiers.push({ text, key: `${name}=${value}` });
      continue;
    }
    const mechanism = /^([+?~-]?)(all|include|a|mx|ptr|ip4|ip6|exists)(.*)$/i.exec(text);
    if (!mechanism) throw new SpfProblem(`"${text}" is not an SPF term`);
    if (parsed.all) throw new SpfProblem("it has terms after all");
    const qualifier = mechanism[1] || "+";
    const kind = mechanism[2]!.toLowerCase();
    const rest = mechanism[3]!;
    if (kind === "all") {
      if (rest) throw new SpfProblem(`"${text}" is malformed`);
      parsed.all = { text, key: qualifier };
      continue;
    }
    // A fail or neutral term before a pass is order-sensitive; adding senders around it is not safe.
    if (qualifier !== "+") throw new SpfProblem(`"${text}" is not a pass term`);
    let key: string;
    if (kind === "ip4" || kind === "ip6") key = addressKey(kind, rest);
    else if (kind === "a" || kind === "mx") key = hostKey(kind, rest);
    else if (kind === "ptr" && !rest) key = "ptr";
    else if (rest.startsWith(":")) key = `${kind}:${domainSpec(rest.slice(1))}`;
    else throw new SpfProblem(`"${text}" needs a domain`);
    parsed.mechanisms.push({ text, key });
  }
  return parsed;
}

function ending(spf: ParsedSpf): string {
  return JSON.stringify([spf.all?.key ?? null, spf.modifiers.map((term) => term.key).sort()]);
}

function lookups(mechanisms: Term[], modifiers: Term[]): number {
  return mechanisms.filter((term) => LOOKUP_MECHANISMS.has(term.key.split(":")[0]!)).length
    + modifiers.filter((term) => term.key.startsWith("redirect=")).length;
}

/**
 * `required` is the profile's SPF; `existing` is every SPF TXT value already
 * at that name. With none, the profile's record is used as it is written.
 */
export function mergeSpf(required: string, existing: string[]): SpfMerge {
  let wanted: ParsedSpf;
  try {
    wanted = parse(required);
  } catch (error) {
    return { ok: false, problem: `The profile's SPF cannot be used: ${(error as Error).message}` };
  }
  if (existing.length === 0) return { ok: true, value: required.trim().replace(/\s+/g, " "), changed: true };

  let current: ParsedSpf[];
  try {
    current = existing.map(parse);
  } catch (error) {
    return { ok: false, problem: `The SPF already published needs a manual merge: ${(error as Error).message}` };
  }
  if (current.some((spf) => ending(spf) !== ending(current[0]!))) {
    return { ok: false, problem: `${existing.length} SPF records end differently; keep one of them in Cloudflare first` };
  }

  const mechanisms = new Map<string, string>();
  for (const spf of [...current, wanted]) {
    for (const term of spf.mechanisms) if (!mechanisms.has(term.key)) mechanisms.set(term.key, term.text);
  }
  const first = current[0]!;
  const terms = [...mechanisms].map(([key, text]) => ({ key, text }));
  const count = lookups(terms, first.modifiers);
  if (count > MAX_LOOKUPS) return { ok: false, problem: `The merged SPF would need ${count} DNS lookups; SPF allows ${MAX_LOOKUPS}` };

  const value = ["v=spf1", ...mechanisms.values(), ...(first.all ? [first.all.text] : []), ...first.modifiers.map((term) => term.text)].join(" ");
  const added = mechanisms.size > new Set(current[0]!.mechanisms.map((term) => term.key)).size;
  return { ok: true, value, changed: existing.length > 1 || added };
}
