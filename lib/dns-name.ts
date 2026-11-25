/**
 * Pure DNS name, TXT quoting and RFC 4592 wildcard helpers shared by
 * `lib/cloudflare/`, `addons/dns/` and `addons/firewall/`.
 */
import { failAction } from "./action";

const LABEL = "(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)";
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/** A DNS name as records use it: underscores allowed, a leading `*.` allowed, no trailing dot. */
export function dnsName(value: string): boolean {
  const name = value.startsWith("*.") ? value.slice(2) : value;
  return value.length <= 253 && HOSTNAME_RE.test(name);
}

export function connectionId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) failAction("that is not a connection identifier");
  return value;
}

export function cloudflareId(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) failAction(`${what} is not a Cloudflare identifier`);
  return value;
}

/** A Cloudflare API token or Mailcow key as pasted: one printable run, no spaces. */
export function secretText(value: unknown, what: string): string {
  if (typeof value !== "string") failAction(`${what} must be text`);
  const secret = value.trim();
  if (!/^[\x21-\x7e]{20,512}$/.test(secret)) failAction(`${what} does not look like one`);
  return secret;
}

/** `"chunk" "chunk"` as one string, which is how a long TXT value travels. */
export function unquoteTxt(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  const chunks = [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"\s*/g)];
  if (chunks.map((chunk) => chunk[0]).join("").trim() !== trimmed) return trimmed;
  return chunks.map((chunk) => chunk[1]!.replace(/\\(["\\])/g, "$1")).join("");
}

/** Every TXT value quoted, in strings of at most 255 characters, as DNS carries them. */
export function quoteTxt(value: string): string {
  const chunks = value.match(/[\s\S]{1,255}/g) ?? [""];
  return chunks.map((chunk) => `"${chunk.replace(/(["\\])/g, "\\$1")}"`).join(" ");
}

function strictAncestors(name: string, zone: string): string[] {
  const result: string[] = [];
  let current = name;
  while (current !== zone) {
    const dot = current.indexOf(".");
    if (dot < 0) break;
    current = current.slice(dot + 1);
    result.push(current);
  }
  return result;
}

/**
 * The RFC 4592 wildcard that synthesises answers for `name` inside `zone`,
 * given every record in the zone. Any record at or below `name`, or at or below
 * an intermediate ancestor that has no wildcard of its own, stops a broader
 * wildcard from matching.
 */
export function wildcardSource<T extends { type: string; name: string }>(
  name: string,
  zone: string,
  records: readonly T[],
  ignore?: (record: T) => boolean,
): { wildcard: string; records: T[] } | null {
  if (name === zone || !name.endsWith(`.${zone}`) || name.startsWith("*.")) return null;
  const others = ignore ? records.filter((record) => !ignore(record)) : records;
  if (others.some((record) => record.name === name || record.name.endsWith(`.${name}`))) return null;
  const ancestors = strictAncestors(name, zone);
  // A delegation zone cut above `name` occludes any wildcard in this zone at or below the cut.
  if (ancestors.some((base) => base !== zone && others.some((record) => record.type === "NS" && record.name === base))) return null;
  for (const base of ancestors) {
    const exists = base === zone || others.some((record) => record.name === base || record.name.endsWith(`.${base}`));
    if (!exists) continue;
    const wildcard = `*.${base}`;
    const found = records.filter((record) => record.name === wildcard);
    return found.length ? { wildcard, records: found } : null;
  }
  return null;
}

/**
 * When `wildcardSource` returns null because another record blocks an ancestor
 * wildcard, returns that wildcard and the blocking record so the plan can say why.
 */
export function wildcardBlocker<T extends { type: string; name: string }>(
  name: string,
  zone: string,
  records: readonly T[],
  ignore?: (record: T) => boolean,
): { wildcard: string; records: T[]; by: T } | null {
  if (name === zone || !name.endsWith(`.${zone}`) || name.startsWith("*.")) return null;
  const others = ignore ? records.filter((record) => !ignore(record)) : records;
  const ancestors = strictAncestors(name, zone);
  if (ancestors.some((base) => base !== zone && others.some((record) => record.type === "NS" && record.name === base))) return null;
  let blocker = others.find((record) => record.name === name || record.name.endsWith(`.${name}`));
  for (const base of ancestors) {
    if (!blocker && base !== zone) {
      const ancestor = others.find((record) => record.name === base || record.name.endsWith(`.${base}`));
      if (ancestor) {
        const wildcard = `*.${base}`;
        if (!records.some((record) => record.name === wildcard)) blocker = ancestor;
        else return null;
      }
    }
    if (!blocker) continue;
    const wildcard = `*.${base}`;
    const found = records.filter((record) => record.name === wildcard);
    if (found.length) return { wildcard, records: found, by: blocker };
  }
  return null;
}
