/**
 * From a profile's rows to the records one site should have, and from those to
 * what has to change in its zone.
 *
 * A row owns the records it could conflict with at its name, and nothing else:
 * an address row owns that address type and any CNAME, a CNAME owns the whole
 * name, and a TXT row owns only TXT of its own kind (SPF, DKIM or DMARC), so a
 * verification TXT beside an SPF record is never touched. Names no row
 * renders are never read for changes at all.
 */
import { isIP } from "node:net";
import type { CfRecord, RecordWrite } from "./cloudflare";
import { dnsName, PROXIABLE, type Profile, type RecordTemplate } from "./model";
import { isSpf, mergeSpf } from "./spf";

export interface SiteVars {
  domain: string;
  zone: string;
  /** Empty when the server has none of that family; null when it could not be told. */
  ipv4: string | null;
  ipv6: string | null;
  mailcowHost: string;
  /** Null when the profile does not use Mailcow, or the selector is not known yet. */
  mailcowSelector: string | null;
  /** Null until Mailcow holds a key for this domain. */
  mailcowDkim: string | null;
}

export type TxtKind = "spf" | "dkim" | "dmarc" | "other";

export interface Claim {
  name: string;
  type: string;
  /** For TXT: which values the row speaks for. */
  kind?: TxtKind;
}

export interface Rendered {
  zone: string;
  records: RecordWrite[];
  claims: Claim[];
  /** Names whose DKIM row waits for Mailcow's key, and must not lose the key they have meanwhile. */
  waitingDkim: string[];
  problems: string[];
}

export function txtKind(value: string): TxtKind {
  if (isSpf(value)) return "spf";
  if (/^v=DKIM1(?:;|\s|$)/i.test(value)) return "dkim";
  if (/^v=DMARC1(?:;|\s|$)/i.test(value)) return "dmarc";
  return "other";
}

export function subdomainPart(domain: string, zone: string): string {
  return domain === zone ? "" : domain.slice(0, -(zone.length + 1));
}

function fill(template: string, vars: SiteVars): string | null {
  const values: Record<string, string | null> = {
    domain: vars.domain,
    zone: vars.zone,
    sub: subdomainPart(vars.domain, vars.zone),
    ipv4: vars.ipv4,
    ipv6: vars.ipv6,
    "mailcow.host": vars.mailcowHost,
    "mailcow.selector": vars.mailcowSelector,
    "mailcow.dkim": vars.mailcowDkim,
  };
  let missing = false;
  const result = template.replace(/\{([^{}]+)\}/g, (_, token: string) => {
    const value = values[token];
    if (value === null || value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? null : result;
}

/** A filled-in name with the dots an empty `{sub}` leaves behind tidied away. */
function recordName(template: string, vars: SiteVars): string | null {
  const filled = fill(template, vars);
  return filled === null ? null : filled.toLowerCase().replace(/\.{2,}/g, ".").replace(/^\.|\.$/g, "");
}

function contentProblem(type: string, content: string): string | null {
  if (type === "A" && isIP(content) !== 4) return "must be an IPv4 address";
  if (type === "AAAA" && isIP(content) !== 6) return "must be an IPv6 address";
  if ((type === "CNAME" || type === "MX") && (!dnsName(content.toLowerCase().replace(/\.$/, "")) || content.startsWith("*"))) return "must be a hostname";
  if (type === "SRV") {
    const [weight, port, target, ...rest] = content.split(/\s+/);
    const numbers = [weight, port].map(Number);
    if (rest.length || !target || numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 65535) || !dnsName(target.toLowerCase().replace(/\.$/, ""))) {
      return "must be weight, port and target, such as 0 443 mail.example.com";
    }
  }
  if (type === "CAA" && !/^\d{1,3}\s+(issue|issuewild|iodef)\s+"?[^"\s]*"?$/i.test(content)) return 'must be flags, tag and value, such as 0 issue "letsencrypt.org"';
  if (type === "TXT" && content.length > 2048) return "is longer than Cloudflare accepts";
  return null;
}

function canonical(type: string, content: string): string {
  if (type === "AAAA" && isIP(content) === 6) return new URL(`http://[${content}]/`).hostname.slice(1, -1);
  if (type === "CNAME" || type === "MX") return content.toLowerCase().replace(/\.$/, "");
  if (type === "SRV") return content.trim().toLowerCase().replace(/\.$/, "").split(/\s+/).join(" ");
  if (type === "CAA") {
    const match = /^(\d+)\s+(\S+)\s+"?(.*?)"?$/.exec(content.trim());
    return match ? `${Number(match[1])} ${match[2]!.toLowerCase()} "${match[3]}"` : content.trim();
  }
  return content;
}

function rowClaims(type: string, name: string, content: string): Claim {
  return type === "TXT" ? { name, type, kind: txtKind(content) } : { name, type };
}

/**
 * The records `profile` wants for one site. SPF rows are returned as written
 * here and merged with what is published once the zone has been read.
 */
export function renderProfile(profile: Profile, vars: SiteVars, skip?: (name: string, type: string) => boolean): Rendered {
  const rendered: Rendered = { zone: vars.zone, records: [], claims: [], waitingDkim: [], problems: [] };
  profile.records.forEach((row: RecordTemplate, index) => {
    const where = `Record ${index + 1} (${row.type} ${row.name})`;
    if (row.apexOnly && vars.domain !== vars.zone) return;
    const name = recordName(row.name, vars);
    if (name === null) {
      rendered.problems.push(`${where}: Mailcow's DKIM selector is not known; check the Mailcow settings`);
      return;
    }
    if (!dnsName(name) || (name !== vars.zone && !name.endsWith(`.${vars.zone}`))) {
      rendered.problems.push(`${where}: ${name || "its name"} is not a name in the ${vars.zone} zone`);
      return;
    }
    if (skip?.(name, row.type)) return;
    const unknown = (["ipv4", "ipv6"] as const).find((family) => vars[family] === null && row.content.includes(`{${family}}`));
    if (unknown) {
      rendered.problems.push(`${where}: this server's ${unknown === "ipv4" ? "IPv4" : "IPv6"} address could not be detected; set it under Server addresses`);
      return;
    }
    const content = fill(row.content, vars);
    if (content === null) {
      // Only the DKIM key can be missing at this point; the selector was checked with the name.
      rendered.claims.push({ name, type: "TXT", kind: "dkim" });
      rendered.waitingDkim.push(name);
      return;
    }
    const value = canonical(row.type, content.trim());
    rendered.claims.push(rowClaims(row.type, name, value));
    // An address row with no address to give still owns its name, so a stale address is removed.
    if ((row.type === "A" || row.type === "AAAA") && value === "") return;
    const problem = contentProblem(row.type, value);
    if (problem) {
      rendered.problems.push(`${where}: its content ${problem}`);
      return;
    }
    if (row.type === "CNAME" && value === name) {
      rendered.problems.push(`${where}: a CNAME cannot point to itself`);
      return;
    }
    rendered.records.push({
      type: row.type,
      name,
      content: value,
      proxied: PROXIABLE.includes(row.type) && row.proxied,
      ttl: row.proxied ? 1 : row.ttl,
      priority: row.priority,
    });
  });
  const unique = new Set<string>();
  const cnameNames = new Set<string>();
  for (const record of rendered.records) {
    const key = JSON.stringify([record.type, record.name, record.content]);
    if (unique.has(key)) rendered.problems.push(`${record.type} ${record.name}: remove the duplicate record row`);
    unique.add(key);
    if (record.type === "CNAME") {
      if (cnameNames.has(record.name)) rendered.problems.push(`${record.name}: only one CNAME row may write to a name`);
      cnameNames.add(record.name);
    }
  }
  for (const name of cnameNames) {
    if (rendered.claims.some((claim) => claim.name === name && claim.type !== "CNAME")) {
      rendered.problems.push(`${name}: a CNAME cannot share its name with other records`);
    }
  }
  const spfNames = rendered.records.filter((record) => record.type === "TXT" && isSpf(record.content)).map((record) => record.name);
  if (new Set(spfNames).size !== spfNames.length) rendered.problems.push("Only one SPF row may write to a name");
  return rendered;
}

const WEB_TYPES = new Set(["A", "AAAA", "CNAME"]);

/**
 * What a redirect domain wants: its profile's rows, if it has one, without the
 * web rows -- address and CNAME rows at the domain and its `www` -- and a
 * proxied placeholder at each host the redirect answers for, which owns every
 * address and CNAME there. Mail rows and anything else render as for a site.
 */
export function renderRedirect(profile: Profile | null, hosts: string[], vars: SiteVars, placeholder: string): Rendered {
  const own = new Set([vars.domain, `www.${vars.domain}`]);
  const web = (name: string, type: string) => own.has(name) && WEB_TYPES.has(type);
  const rendered: Rendered = profile ? renderProfile(profile, vars, web) : { zone: vars.zone, records: [], claims: [], waitingDkim: [], problems: [] };
  for (const host of hosts) {
    rendered.records.push({ type: "AAAA", name: host, content: placeholder, proxied: true, ttl: 1, priority: null });
    rendered.claims.push({ name: host, type: "A" }, { name: host, type: "AAAA" });
  }
  return rendered;
}

/** Whether a published record is one of the records `claims` speak for. */
export function claimedBy(record: CfRecord, claims: Claim[]): boolean {
  return claims.some((claim) => {
    if (claim.name !== record.name) return false;
    if (claim.type === "CNAME" || record.type === "CNAME") return true;
    if (claim.type !== record.type) return false;
    if (claim.type !== "TXT") return true;
    return claim.kind !== "other" && claim.kind === txtKind(record.content);
  });
}

export function sameRecord(current: CfRecord, wanted: RecordWrite): boolean {
  if (current.type !== wanted.type || current.name !== wanted.name) return false;
  if (canonical(current.type, current.content) !== canonical(wanted.type, wanted.content)) return false;
  if (PROXIABLE.includes(wanted.type as never) && current.proxied !== wanted.proxied) return false;
  // Cloudflare reports a proxied record's TTL as Auto whatever was asked for.
  if (!wanted.proxied && current.ttl !== wanted.ttl) return false;
  return (current.priority ?? null) === (wanted.priority ?? null);
}

export interface RecordOp {
  action: "create" | "update" | "delete";
  record: RecordWrite;
  /** The published record an update or delete acts on. */
  current?: CfRecord;
}

export interface Diff {
  ops: RecordOp[];
  /** Records this site already has exactly as wanted, kept for the orphan inventory. */
  matched: CfRecord[];
  /** The records wanted once SPF is merged, for comparing sites and reporting. */
  wanted: RecordWrite[];
  /** Every name the profile writes at, wanted or not, which no orphan removal may touch. */
  names: string[];
  problems: string[];
}

const PROTECTED = new Set(["NS", "SOA"]);

/** What it takes to turn `published` into what `rendered` wants, without touching anything it does not claim. */
export function diffRecords(rendered: Rendered, published: CfRecord[]): Diff {
  const diff: Diff = { ops: [], matched: [], wanted: [], names: [...new Set(rendered.claims.map((claim) => claim.name))], problems: [...rendered.problems] };
  for (const record of rendered.records) {
    if (record.type !== "TXT" || !isSpf(record.content)) {
      diff.wanted.push(record);
      continue;
    }
    const existing = published.filter((current) => current.type === "TXT" && current.name === record.name && isSpf(current.content));
    const merged = mergeSpf(record.content, existing.map((current) => current.content));
    if (!merged.ok) {
      diff.problems.push(`${record.name}: ${merged.problem}`);
      continue;
    }
    // An SPF record that already lists every sender the profile needs is left exactly as written.
    diff.wanted.push({ ...record, content: merged.changed ? merged.value : existing[0]!.content });
  }

  const pool = published.filter((current) => claimedBy(current, rendered.claims) && !rendered.waitingDkim.includes(current.name));
  const blocked = pool.filter((current) => PROTECTED.has(current.type));
  for (const current of blocked) diff.problems.push(`${current.name} has ${current.type} records, which this addon does not replace`);
  // Below the zone's own apex, NS records hand a name to other nameservers, and records written here would never be seen.
  const delegations = published.filter((current) => current.type === "NS" && current.name !== rendered.zone);
  for (const name of new Set(delegations.map((current) => current.name))) {
    if (rendered.claims.some((claim) => claim.name === name || claim.name.endsWith(`.${name}`))) {
      diff.problems.push(`${name} is delegated to other nameservers by NS records`);
    }
  }
  const used = new Set<CfRecord>(blocked);

  const wanted = diff.wanted.map((record) => {
    const kind = record.type === "TXT" ? txtKind(record.content) : null;
    // A TXT value of no known kind is only ever looked for, among every TXT at its name.
    const candidates = kind === "other"
      ? published.filter((current) => current.type === "TXT" && current.name === record.name && current.content === record.content)
      : pool.filter((current) => current.type === record.type && current.name === record.name
        && (kind === null || txtKind(current.content) === kind));
    return { record, candidates };
  });
  // Exact matches first, then records that differ only in proxy, TTL or priority, then any other: Cloudflare refuses
  // a second record with the same content, so an update must never give one record another's content.
  const passes = [
    (current: CfRecord, record: RecordWrite) => sameRecord(current, record),
    (current: CfRecord, record: RecordWrite) => canonical(current.type, current.content) === canonical(record.type, record.content),
    () => true,
  ];
  const updates: RecordOp[] = [];
  let unmatched = wanted;
  for (const [pass, fits] of passes.entries()) {
    unmatched = unmatched.filter(({ record, candidates }) => {
      const current = candidates.find((candidate) => !used.has(candidate) && fits(candidate, record));
      if (!current) return true;
      used.add(current);
      if (pass === 0) diff.matched.push(current);
      else updates.push({ action: "update", record, current });
      return false;
    });
  }
  const creates: RecordOp[] = unmatched.map(({ record }) => ({ action: "create", record }));
  const deletes: RecordOp[] = pool.filter((current) => !used.has(current)).map((current) => ({ action: "delete", record: current, current }));
  // In place first, so a merged SPF is saved before its duplicates go; then what blocks a create.
  diff.ops = [...updates, ...deletes, ...creates];
  return diff;
}

/** One line for a record, as the page shows it. */
export function describeRecord(record: RecordWrite): string {
  const parts = [record.content];
  if (record.priority !== null && record.priority !== undefined) parts.push(`priority ${record.priority}`);
  if (PROXIABLE.includes(record.type as never)) parts.push(record.proxied ? "proxied" : "DNS only");
  if (!record.proxied && record.ttl !== 1) parts.push(`TTL ${record.ttl}`);
  return parts.join(" · ");
}
