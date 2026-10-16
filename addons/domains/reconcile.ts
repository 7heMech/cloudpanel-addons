import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import type { ApiFetch } from "../../lib/provider-http";
import { Cloudflare, Mailcow, type Dkim, type Rule, type Ruleset } from "./providers";
import { claimed, desiredRecords, diffRecords, sameRecord, type Desired } from "./records";
import type { Change, Connections, DnsRecord, Orphan, PanelSite, Policy, Profile, SitePlan, Zone } from "./model";

export interface EngineOptions {
  connections: Connections;
  ips: { ipv4: string; ipv6: string };
  fetch?: ApiFetch;
  retry?: { cloudflare: number; mailcow: number };
}
interface RuleWork { phase: string; rule: Rule; set: Ruleset | null; existingId?: string }
interface SiteWork { site: PanelSite; profile: Profile; desired: Desired; records: DnsRecord[]; mailExists: boolean; key: Dkim | null; acl: string[]; rules: RuleWork[]; settings: { name: string; value: string }[] }
export interface FleetPlan { sites: SitePlan[]; work: Map<string, SiteWork>; zones: Zone[] }
const reason = (e: unknown) => e instanceof Error ? e.message : "Provider operation failed";
const profileOf = (policy: Policy, site: string) => policy.profiles.find((p) => p.id === policy.assignments[site]);
export function matchingZone(name: string, zones: Zone[]): Zone | null {
  const matches = zones.filter((z) => name === z.name || name.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length);
  if (matches.length > 1 && matches[0]!.name === matches[1]!.name) throw new Error("Multiple Cloudflare zones match the site equally");
  return matches[0] ?? null;
}
function equivalentRule(a: Partial<Rule>, b: Rule): boolean {
  return a.action === b.action && a.expression === b.expression && a.enabled !== false && JSON.stringify(a.action_parameters) === JSON.stringify(b.action_parameters) && JSON.stringify(a.logging) === JSON.stringify(b.logging);
}
export function profileRules(p: Profile, site: PanelSite, zone: Zone): { phase: string; rule: Rule }[] {
  const ref = createHash("sha256").update(site.domain).digest("hex").slice(0, 16);
  const hosts = [site.domain, ...(site.domain === zone.name ? [`www.${site.domain}`] : [])];
  const hostExpression = `http.host in {${hosts.map((d) => `"${d}"`).join(" ")}}`;
  const full = (kind: string, expression: string, description: string) => ({ phase: "http_config_settings", rule: { ref: `clp_domains_${ref}_${kind}`, action: "set_config", expression, description, enabled: true, action_parameters: { ssl: "full" } } });
  const rules: { phase: string; rule: Rule }[] = [];
  if (p.acmeRule) rules.push(full("acme", `(${hostExpression}) and starts_with(http.request.uri.path, "/.well-known/acme-challenge/")`, `CloudPanel ACME: ${site.domain}`));
  if (p.webmailRule) rules.push(full("webmail", `http.host eq "webmail.${site.domain}"`, `CloudPanel webmail: ${site.domain}`));
  if (p.mainwpIps.length) rules.push({ phase: "http_request_firewall_custom", rule: { ref: `clp_domains_${ref}_mainwp`, action: "skip", expression: `(${hostExpression}) and ip.src in {${p.mainwpIps.join(" ")}}`, description: `CloudPanel MainWP: ${site.domain}`, enabled: true, action_parameters: { phases: ["http_request_sbfm", "http_request_firewall_managed"] }, logging: { enabled: true } } });
  return rules;
}
function aclHas(acl: string[], name: string): boolean { return acl.includes("*") || acl.includes(name) || acl.includes(`@${name}`); }

export class DomainsEngine {
  readonly cloudflare: Cloudflare;
  readonly mailcow: Mailcow;
  constructor(readonly options: EngineOptions) {
    this.cloudflare = new Cloudflare(options.connections, options.fetch, options.retry?.cloudflare);
    this.mailcow = new Mailcow(options.connections, options.fetch, options.retry?.mailcow);
  }
  retry(): { cloudflare: number; mailcow: number } { return { cloudflare: this.cloudflare.http.retryAt, mailcow: this.mailcow.http.retryAt }; }

  async scan(policy: Policy, sites: PanelSite[]): Promise<FleetPlan> {
    const work = new Map<string, SiteWork>();
    let zones: Zone[] = [], zoneError = "";
    if (sites.some((s) => profileOf(policy, s.domain))) {
      if (!this.options.connections.cloudflareToken || !this.options.connections.accountId) zoneError = "Save a Cloudflare account and API token first";
      else try { zones = await this.cloudflare.zones(); } catch (e) { zoneError = reason(e); }
    }
    const recordCache = new Map<string, Promise<DnsRecord[]>>();
    const ruleCache = new Map<string, Promise<Ruleset | null>>();
    const settingCache = new Map<string, Promise<string>>();
    const aclCache = new Map<string, Promise<string[]>>();
    function cached<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
      if (!cache.has(key)) cache.set(key, read());
      return cache.get(key)!;
    }
    const plans = await Promise.all(sites.map(async (site): Promise<SitePlan> => {
      const p = profileOf(policy, site.domain);
      const plan: SitePlan = { domain: site.domain, type: site.type, profileId: p?.id ?? null, mode: p?.mode ?? "report", certificateReady: site.certificateReady, waitingCertificate: false, unproxiedWeb: Boolean(p && !p.webProxied), zone: null, changes: [], errors: [], cloudflareOnly: site.cloudflareOnly };
      if (!p) return plan;
      if (zoneError) { plan.errors.push(zoneError); return plan; }
      try {
        let zone = matchingZone(site.domain, zones);
        if (!zone) {
          const name = getDomain(site.domain, { allowPrivateDomains: false });
          if (!name) throw new Error("Cannot determine a registrable zone for this site");
          if (!p.createZones) throw new Error(`Zone ${name} is missing and zone creation is off`);
          zone = { id: "", name, status: "missing", nameServers: [] };
          plan.changes.push({ action: "create", service: "zone", name, detail: "Create zone; switch its assigned nameservers at the registrar manually" });
        }
        plan.zone = zone;
        const records = zone.id ? await cached(recordCache, zone.id, () => this.cloudflare.records(zone!.id)) : [];
        let mailExists = false, key: Dkim | null = null, plannedKey: Dkim | null = null, acl: string[] = [];
        if (p.mailEnabled) {
          if (!this.options.connections.mailcowKey || !this.options.connections.mailcowUrl) throw new Error("Save a Mailcow HTTPS endpoint and API key first");
          if (!p.mailHost || !p.webmailHost || !p.sharedMailbox || !p.mailIpv4 && !p.mailIpv6) throw new Error("Mail profiles need the mail host, webmail host, mail IPs and shared mailbox");
          [mailExists, key, acl] = await Promise.all([
            this.mailcow.hasDomain(site.domain), this.mailcow.dkim(site.domain),
            cached(aclCache, p.sharedMailbox, () => this.mailcow.mailbox(p.sharedMailbox)),
          ]);
          if (!mailExists) plan.changes.push({ action: "create", service: "mailcow", name: site.domain, detail: "Add the Mailcow domain (never removed automatically)" });
          if (!key) {
            if (p.dkimSource) {
              plannedKey = await this.mailcow.dkim(p.dkimSource);
              if (!plannedKey) throw new Error("The DKIM source domain has no key in Mailcow");
            }
            plan.changes.push({ action: "create", service: "mailcow", name: site.domain, detail: p.dkimSource ? `Duplicate DKIM from ${p.dkimSource}` : `Generate ${p.dkimBits}-bit DKIM with selector ${p.dkimSelector}` });
          }
          if (!aclHas(acl, site.domain)) plan.changes.push({ action: "update", service: "mailcow", name: p.sharedMailbox, detail: `Add ${site.domain} to sender ACL; keep existing grants` });
        }
        const desired = desiredRecords(p, site, zone, this.options.ips, key ?? plannedKey, records);
        plan.waitingCertificate = desired.waitingCertificate;
        plan.unproxiedWeb = desired.records.some((r) => r.name === site.domain && ["A", "AAAA", "CNAME"].includes(r.type) && !r.proxied);
        plan.hasWebAddress = desired.records.some((r) => r.name === site.domain && ["A", "AAAA", "CNAME"].includes(r.type));
        plan.changes.push(...diffRecords(records, desired));
        const settings: SiteWork["settings"] = [], rules: RuleWork[] = [];
        if (p.zoneSettings) for (const [name, value] of [["ssl", "strict"], ["always_use_https", "on"]] as const) {
          const current = zone.id ? await cached(settingCache, `${zone.id}:${name}`, () => this.cloudflare.setting(zone!.id, name)) : "default";
          if (current !== value) {
            settings.push({ name, value });
            plan.changes.push({ action: "update", service: "zone", name: `${zone.name}: ${name}`, detail: `${current} → ${value} (applies to the whole zone)` });
          }
        }
        for (const r of profileRules(p, site, zone)) {
          const set = zone.id ? await cached(ruleCache, `${zone.id}:${r.phase}`, () => this.cloudflare.entrypoint(zone!.id, r.phase)) : null;
          const own = set?.rules.filter((existing) => existing.ref === r.rule.ref) ?? [];
          if (own.length > 1) throw new Error("The Cloudflare rule reference is duplicated");
          const existing = own[0] ?? set?.rules.find((existing) => equivalentRule(existing, r.rule));
          if (existing?.ref === r.rule.ref && equivalentRule(existing, r.rule)) continue;
          rules.push({ ...r, set, existingId: existing?.id });
          plan.changes.push({ action: existing ? "update" : "create", service: "rule", name: r.rule.description, detail: `${r.rule.expression} → ${JSON.stringify(r.rule.action_parameters)}` });
        }
        if (plan.changes.some((c) => c.action === "conflict")) plan.errors.push("A protected DNS record prevents this profile");
        work.set(site.domain, { site, profile: p, desired, records, mailExists, key, acl, rules, settings });
      } catch (e) { plan.errors.push(reason(e)); }
      return plan;
    }));
    for (let i = 0; i < plans.length; i++) {
      const a = plans[i]!, aw = work.get(a.domain);
      if (!aw || !a.zone) continue;
      for (const b of plans.slice(i + 1)) {
        const bw = work.get(b.domain);
        if (!bw || a.zone.name !== b.zone?.name) continue;
        const overlap = aw.desired.records.some((r) => claimed(r, bw.desired) && !bw.desired.records.some((s) => sameRecord(r, s)))
          || bw.desired.records.some((r) => claimed(r, aw.desired) && !aw.desired.records.some((s) => sameRecord(r, s)));
        if (overlap) { a.errors.push(`Profile conflicts with site ${b.domain} at a shared DNS name`); b.errors.push(`Profile conflicts with site ${a.domain} at a shared DNS name`); }
      }
    }
    return { sites: plans, work, zones };
  }

  async enforce(policy: Policy, sites: PanelSite[], plan: FleetPlan, selected?: Set<string>): Promise<FleetPlan> {
    const errors = new Map<string, string[]>();
    const eligible = () => plan.sites.filter((s) => s.mode === "enforce" && s.errors.length === 0 && !errors.has(s.domain) && (!selected || selected.has(s.domain)));
    const protect = async (site: SitePlan, body: () => Promise<void>) => {
      try { await body(); } catch (e) { errors.set(site.domain, [reason(e)]); }
    };
    const zoneCreates = new Map<string, Promise<Zone>>();
    await Promise.all(eligible().filter((s) => s.zone?.status === "missing").map((s) => protect(s, async () => {
      if (!zoneCreates.has(s.zone!.name)) zoneCreates.set(s.zone!.name, this.cloudflare.createZone(s.zone!.name));
      await zoneCreates.get(s.zone!.name);
    })));
    if (zoneCreates.size) plan = await this.scan(policy, sites);
    const zoneTasks = new Map<string, Promise<void>>();
    await Promise.all(eligible().map((s) => protect(s, async () => {
      const w = plan.work.get(s.domain)!;
      for (const setting of w.settings) {
        const key = `${s.zone!.id}:${setting.name}`;
        if (!zoneTasks.has(key)) zoneTasks.set(key, this.cloudflare.setSetting(s.zone!.id, setting.name, setting.value));
        await zoneTasks.get(key);
      }
    })));
    // A phase's rule writes are sequential so creating an entrypoint cannot replace another site's rules.
    for (const s of eligible()) await protect(s, async () => {
      for (const r of plan.work.get(s.domain)!.rules) {
        const set = await this.cloudflare.entrypoint(s.zone!.id, r.phase);
        const current = set?.rules.find((v) => v.ref === r.rule.ref);
        if (current && equivalentRule(current, r.rule)) continue;
        await this.cloudflare.writeRule(s.zone!.id, r.phase, set, r.rule, current?.id ?? r.existingId);
      }
    });
    await Promise.all(eligible().map((s) => protect(s, async () => {
      const w = plan.work.get(s.domain)!;
      if (!w.profile.mailEnabled) return;
      if (!w.mailExists) await this.mailcow.addDomain(s.domain);
      if (!await this.mailcow.hasDomain(s.domain)) throw new Error("Mailcow did not confirm the domain");
      if (!await this.mailcow.dkim(s.domain)) await this.mailcow.addDkim(s.domain, w.profile);
      if (!await this.mailcow.dkim(s.domain)) throw new Error("Mailcow did not return the DKIM key after creation");
    })));
    const mailboxes = [...new Set(eligible().map((s) => plan.work.get(s.domain)!.profile).filter((p) => p.mailEnabled).map((p) => p.sharedMailbox))];
    await Promise.all(mailboxes.map(async (mailbox) => {
      const group = eligible().filter((s) => plan.work.get(s.domain)!.profile.sharedMailbox === mailbox);
      try {
        const acl = await this.mailcow.mailbox(mailbox);
        const missing = group.filter((s) => !aclHas(acl, s.domain)).map((s) => `@${s.domain}`);
        if (missing.length) await this.mailcow.setAcl(mailbox, [...new Set([...acl, ...missing])]);
        const after = await this.mailcow.mailbox(mailbox);
        if (group.some((s) => !aclHas(after, s.domain))) throw new Error("Mailcow did not confirm the sender ACL");
      } catch (e) { for (const s of group) errors.set(s.domain, [reason(e)]); }
    }));
    const zoneGroups = Map.groupBy(eligible(), (s) => s.zone!.id);
    await Promise.all([...zoneGroups].map(async ([zoneId, group]) => {
      let records: DnsRecord[];
      try { records = await this.cloudflare.records(zoneId); }
      catch (e) { for (const s of group) errors.set(s.domain, [reason(e)]); return; }
      for (const s of group) await protect(s, async () => {
        const w = plan.work.get(s.domain)!;
        const key = w.profile.mailEnabled ? await this.mailcow.dkim(s.domain) : null;
        const desired = desiredRecords(w.profile, w.site, s.zone!, this.options.ips, key, records);
        const changes = diffRecords(records, desired);
        if (changes.some((c) => c.deferred || c.action === "conflict")) throw new Error("DNS prerequisites are not ready");
        const spfUpdates = changes.filter((c) => c.action === "update" && c.after!.type === "TXT" && desired.claims.some((claim) => claim.name === c.name && claim.family === "spf"));
        for (const c of spfUpdates) {
          const record = await this.cloudflare.writeRecord(zoneId, c.after!);
          records = records.filter((r) => r.id !== record.id); records.push(record);
        }
        for (const c of changes.filter((c) => c.action === "delete")) {
          await this.cloudflare.deleteRecord(zoneId, c.before!.id!);
          records = records.filter((r) => r.id !== c.before!.id);
        }
        for (const c of changes.filter((c) => c.after && !spfUpdates.includes(c))) {
          const record = await this.cloudflare.writeRecord(zoneId, c.after!);
          records = records.filter((r) => r.id !== record.id); records.push(record);
        }
      });
    }));
    const result = await this.scan(policy, sites);
    for (const s of result.sites) s.errors.push(...(errors.get(s.domain) ?? []));
    return result;
  }
}

export function rememberRecords(inventory: Orphan[], plan: FleetPlan): Orphan[] {
  const result = structuredClone(inventory);
  for (const s of plan.sites) {
    if (!s.zone?.id || s.errors.length) continue;
    const w = plan.work.get(s.domain);
    if (!w) continue;
    const records = w.records.filter((r) => w.desired.records.some((d) => sameRecord(r, d)));
    if (!records.length) continue;
    let saved = result.find((v) => v.domain === s.domain && v.zoneId === s.zone!.id);
    if (!saved) { saved = { domain: s.domain, zoneId: s.zone.id, zoneName: s.zone.name, records: [] }; result.push(saved); }
    for (const r of records) {
      saved.records = saved.records.filter((v) => v.id !== r.id); saved.records.push(r);
    }
  }
  return result;
}
export function provisionReadiness(plan: SitePlan | undefined): { ready: boolean; reason: string } {
  if (!plan?.profileId) return { ready: false, reason: "The site has no DNS and mail profile. Ask an administrator to assign one." };
  if (plan.mode !== "enforce") return { ready: false, reason: "The profile is Report only. An administrator must review its plan and enable Enforce." };
  if (plan.errors.length) return { ready: false, reason: plan.errors.join("; ") };
  if (!plan.zone || plan.zone.status !== "active") return { ready: false, reason: `Zone ${plan.zone?.name ?? ""} is ${plan.zone?.status ?? "missing"}. Switch to its assigned nameservers at the registrar${plan.zone?.nameServers.length ? `: ${plan.zone.nameServers.join(", ")}` : ""}.` };
  if (plan.changes.some((c) => !c.deferred)) return { ready: false, reason: "DNS or mail changes are still pending; check the profile plan." };
  if (plan.hasWebAddress === false) return { ready: false, reason: "The profile manages no web address for this site, so it cannot confirm HTTP-01 readiness." };
  if (plan.unproxiedWeb && plan.cloudflareOnly) return { ready: false, reason: "Unproxied web records cannot pass Cloudflare-only origin access. Use proxy with the ACME rule or turn off Cloudflare-only for this site." };
  return { ready: true, reason: "DNS and mail are ready" };
}
