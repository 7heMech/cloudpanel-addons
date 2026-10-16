import { isIP } from "node:net";
import { domain, recordName, type Change, type DnsRecord, type PanelSite, type Profile, type Zone } from "./model";
import { unquoteTxt, type Dkim } from "./providers";

export interface Claim { name: string; type: string; family: "all" | "spf" | "dkim" }
export interface Desired { records: DnsRecord[]; claims: Claim[]; deferredDkim: boolean; waitingCertificate: boolean }
const mailTokens = /\{(?:mail\.[^}]+|webmail\.host|spf|dkim|selector)\}/;

export function desiredRecords(p: Profile, site: PanelSite, zone: Zone, ips: { ipv4: string; ipv6: string }, dkim: Dkim | null): Desired {
  const records: DnsRecord[] = [], claims: Claim[] = [];
  const includes = [...new Set([...p.spfIncludes, ...(p.spfByDomain[site.domain] ?? [])])].map((s) => `include:${s}`);
  const spf = ["v=spf1", ...includes, ...(p.mailIpv4 ? [`ip4:${p.mailIpv4}`] : []), ...(p.mailIpv6 ? [`ip6:${p.mailIpv6}`] : []), "~all"].join(" ");
  const tokens: Record<string, string> = { domain: site.domain, "server.ipv4": p.serverIpv4 || ips.ipv4, "server.ipv6": p.serverIpv6 || ips.ipv6,
    "mail.host": p.mailHost, "mail.ipv4": p.mailIpv4, "mail.ipv6": p.mailIpv6, "webmail.host": p.webmailHost,
    spf, dkim: dkim?.txt ?? "", selector: dkim?.selector ?? p.dkimSelector };
  const render = (s: string) => s.replace(/\{([^}]+)\}/g, (_, token: string) => {
    if (!(token in tokens)) throw new Error(`Unknown record placeholder {${token}}`);
    return tokens[token]!;
  });
  let deferredDkim = false, waitingCertificate = false;
  for (const t of p.templates) {
    if (t.apexOnly && site.domain !== zone.name || !p.mailEnabled && mailTokens.test(`${t.name} ${t.content} ${t.data?.target ?? ""}`)) continue;
    const name = render(t.name).toLowerCase().replace(/\.$/, "");
    if (!recordName(name) || name !== site.domain && !name.endsWith(`.${site.domain}`)) throw new Error("Record templates must stay within their site's domain");
    const family = t.content.includes("{spf}") ? "spf" : t.content.includes("{dkim}") ? "dkim" : "all";
    if (!claims.some((c) => c.name === name && c.type === t.type && c.family === family)) claims.push({ name, type: t.type, family });
    if (family === "dkim" && !dkim) { deferredDkim = true; continue; }
    const content = render(t.content);
    if (!content && (t.type === "A" || t.type === "AAAA")) continue;
    if (t.type === "A" && isIP(content) !== 4 || t.type === "AAAA" && isIP(content) !== 6) throw new Error(`No valid IPv${t.type === "A" ? "4" : "6"} for ${name}`);
    if (["MX", "CNAME"].includes(t.type)) domain(content, "Record target");
    if (t.type === "CNAME" && domain(content) === name) throw new Error(`CNAME cannot point to itself at ${name}; use a separate hub profile`);
    const certCoversName = site.certificateReady && site.certificateNames.some((v) => v === name || v.startsWith("*.") && name.endsWith(v.slice(1)) && name.split(".").length === v.split(".").length);
    const gated = t.proxy === "web" && p.webProxied && p.proxyAfterCertificate && !certCoversName;
    if (gated) waitingCertificate = true;
    const record: DnsRecord = { type: t.type, name, content, ttl: 1, comment: `clp-addons:domains ${site.domain}` };
    if (["A", "AAAA", "CNAME"].includes(t.type)) record.proxied = (t.proxy === "on" || t.proxy === "web" && p.webProxied) && !gated;
    if (t.priority !== undefined) record.priority = t.priority;
    if (t.data) record.data = { ...t.data, target: domain(render(t.data.target), "SRV target") };
    records.push(record);
  }
  for (const r of records) {
    if (r.type === "CNAME" && records.filter((s) => s.name === r.name).length > 1) throw new Error(`CNAME template conflicts at ${r.name}`);
    if (records.filter((s) => s.name === r.name && s.type === r.type && s.content === r.content).length > 1) throw new Error(`Duplicate record template at ${r.name}`);
    if (r.type === "TXT" && /^v=spf1(?:\s|$)/i.test(r.content) && records.filter((s) => s.name === r.name && s.type === "TXT" && /^v=spf1(?:\s|$)/i.test(s.content)).length > 1) throw new Error(`Only one SPF template is allowed at ${r.name}`);
  }
  if (p.templates.some((t) => ["A", "AAAA"].includes(t.type) && !mailTokens.test(t.content)) && !records.some((r) => r.type === "A" || r.type === "AAAA")) throw new Error("No web address is available; set a server IP override");
  return { records, claims, deferredDkim, waitingCertificate };
}
function canonicalContent(r: DnsRecord): string {
  if (r.type === "TXT") return unquoteTxt(r.content);
  if (["CNAME", "MX"].includes(r.type)) return r.content.toLowerCase().replace(/\.$/, "");
  if (r.type === "AAAA") return new URL(`http://[${r.content}]/`).hostname;
  if (r.type === "SRV") return JSON.stringify(r.data);
  return r.content;
}
export function sameRecord(a: DnsRecord, b: DnsRecord): boolean {
  return a.type === b.type && a.name === b.name && canonicalContent(a) === canonicalContent(b) && a.ttl === b.ttl
    && (!["A", "AAAA", "CNAME"].includes(a.type) || Boolean(a.proxied) === Boolean(b.proxied)) && (a.priority ?? 0) === (b.priority ?? 0);
}
export function claimed(record: DnsRecord, desired: Desired): boolean {
  return desired.claims.some((c) => c.name === record.name && (c.type === "CNAME" || record.type === "CNAME" || c.type === record.type && (c.family !== "spf" || /^v=spf1(?:\s|$)/i.test(unquoteTxt(record.content)))));
}
export function diffRecords(current: DnsRecord[], desired: Desired): Change[] {
  const changes: Change[] = [];
  const pool = current.filter((r) => claimed(r, desired));
  const used = new Set<DnsRecord>();
  const marked = (r: DnsRecord) => (r.comment ?? "").includes("clp-addons:domains") || r.tags?.includes("clp-addons:domains");
  const preservingNotes = (before: DnsRecord, after: DnsRecord): DnsRecord => ({ ...after, id: before.id,
    ...(before.comment ? { comment: before.comment } : {}),
    tags: [...new Set([...(before.tags ?? []), ...(!marked(before) && before.comment ? ["clp-addons:domains"] : [])])],
  });
  for (const after of desired.records) {
    const exact = pool.find((r) => !used.has(r) && sameRecord(r, after));
    if (exact) {
      used.add(exact);
      if (!marked(exact)) changes.push({ action: "update", service: "dns", name: after.name, detail: `Adopt ${after.type} and add the addon marker`, before: exact, after: preservingNotes(exact, after) });
      continue;
    }
    const drift = pool.find((r) => !used.has(r) && r.type === after.type && r.name === after.name);
    if (drift) {
      used.add(drift);
      changes.push({ action: "update", service: "dns", name: after.name, detail: `Correct ${after.type} drift`, conflict: true, before: drift, after: preservingNotes(drift, after) });
    } else changes.push({ action: "create", service: "dns", name: after.name, detail: `Create ${after.type}`, after });
  }
  for (const before of pool) {
    if (used.has(before) || desired.deferredDkim && desired.claims.some((c) => c.family === "dkim" && c.name === before.name)) continue;
    const protectedRecord = ["NS", "SOA"].includes(before.type);
    changes.push({ action: protectedRecord ? "conflict" : "delete", service: "dns", name: before.name,
      detail: protectedRecord ? `Protected ${before.type} prevents this template` : `Delete conflicting ${before.type}`, before, conflict: true });
  }
  if (desired.deferredDkim) for (const c of desired.claims.filter((c) => c.family === "dkim")) {
    const candidates = pool.filter((r) => r.name === c.name && !used.has(r));
    const existing = candidates.find((r) => r.type === "TXT");
    changes.push({ action: existing ? "update" : "create", service: "dns", name: c.name, detail: "Publish the public key read back from Mailcow after DKIM creation", ...(existing ? { before: existing, conflict: true } : {}), deferred: true });
    for (const before of candidates.filter((r) => r !== existing)) changes.push({ action: "delete", service: "dns", name: before.name, detail: `Delete conflicting ${before.type} before publishing DKIM`, before, conflict: true });
  }
  return changes;
}
