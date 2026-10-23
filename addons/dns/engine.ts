/**
 * One pass over Cloudflare and Mailcow: find what every connection can reach,
 * read the zones the fleet's sites live in, work out each site's plan, and --
 * for sites whose profile enforces -- carry it out.
 *
 * Planning is synchronous over what was read, so the same pass can plan,
 * write, and plan again for its report without reading everything twice.
 */
import { getDomain } from "tldts";
import type { Addresses } from "./addresses";
import { CloudflareApi, type CfAccount, type CfRecord, type CfRuleset, type CfZone } from "./cloudflare";
import { type ApiFetch, ProviderError } from "./http";
import { aclAllows, MailcowApi, type MailcowDkim } from "./mailcow";
import type { AccountRef, Policy, Profile, Secrets } from "./model";
import { describeRecord, diffRecords, renderProfile, type Diff, type RecordOp, type SiteVars } from "./records";
import { CONFIG_PHASE, FIREWALL_PHASE, ruleState, SSL_LABELS, wantedRules, wantedSettings, zoneWants, type ZoneWants } from "./zone";

export const RECORD_COMMENT = "Managed by CloudPanel DNS";

export interface PanelSite {
  id: number;
  domain: string;
  type: string;
  /** When CloudPanel created it, in milliseconds. */
  createdAt: number;
  /** Still on the self-signed certificate CloudPanel creates a site with. */
  selfSigned: boolean;
  cloudflareOnly: boolean;
}

export interface ConnectionReport {
  id: string;
  label: string;
  active: boolean;
  status: string;
  accounts: CfAccount[];
  zones: number;
  error: string | null;
}

interface ZoneRef {
  zone: CfZone;
  connectionId: string;
}

export interface ZoneView {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  account: string;
  connection: string;
}

export interface Change {
  action: "create" | "update" | "delete" | "note";
  subject: string;
  detail: string;
  before?: string;
}

export interface SitePlan {
  domain: string;
  profileId: string | null;
  mode: "report" | "enforce";
  zone: ZoneView | null;
  changes: Change[];
  /** What keeps this site from being planned or enforced at all. */
  problems: string[];
  /** Where two connections reach this site's zone and one has to be chosen. */
  zoneChoices: { zone: string; connectionId: string; zoneId: string; label: string }[];
  /** The names a certificate can be requested for once DNS is in place. */
  certificateNames: string[];
}

export interface ManagedRecords {
  zoneId: string;
  zoneName: string;
  connectionId: string;
  records: CfRecord[];
}

export interface RunContext {
  policy: Policy;
  secrets: Secrets;
  sites: PanelSite[];
  addresses: Addresses;
  fetch?: ApiFetch;
  /** When each provider asked to be left alone until, carried between runs. */
  backoff: { cloudflare: number; mailcow: number };
}

interface ZoneState {
  ref: ZoneRef;
  records: CfRecord[] | null;
  settings: Map<string, string>;
  rulesets: Map<string, CfRuleset | null>;
  error: string | null;
}

interface MailState {
  exists: boolean;
  dkim: MailcowDkim | null;
}

type Resolution =
  | { kind: "zone"; ref: ZoneRef }
  | { kind: "missing"; name: string; createIn: AccountRef | null }
  | { kind: "choose"; candidates: ZoneRef[]; name: string }
  | { kind: "unreachable"; reason: string };

const INACTIVE_ZONES = new Set(["moved", "deleted", "deactivated"]);
const MAILCOW_PLACEHOLDER = /\{mailcow\./;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DnsRun {
  readonly connections: ConnectionReport[] = [];
  private readonly zoneRefs: ZoneRef[] = [];
  private readonly zones = new Map<string, ZoneState>();
  private readonly mail = new Map<string, MailState | { error: string }>();
  private readonly acl = new Map<string, string[] | null | { error: string }>();
  private sourceDkim: MailcowDkim | null | { error: string } | undefined;
  private readonly failures = new Map<string, string[]>();
  private readonly diffs = new Map<string, Diff>();
  private profilesByZone: Map<string, Profile[]> | null = null;
  private readonly cloudflare = new Map<string, CloudflareApi>();
  private readonly mailcow: MailcowApi | null;
  private readonly cloudflareBackoff: { until: number };
  private readonly mailcowBackoff: { until: number };

  constructor(private readonly context: RunContext) {
    this.cloudflareBackoff = { until: context.backoff.cloudflare };
    this.mailcowBackoff = { until: context.backoff.mailcow };
    for (const connection of context.policy.connections) {
      const token = context.secrets.cloudflare[connection.id];
      if (token) this.cloudflare.set(connection.id, new CloudflareApi(token, context.fetch, this.cloudflareBackoff));
    }
    const { url } = context.policy.mailcow;
    this.mailcow = url && context.secrets.mailcowKey
      ? new MailcowApi(url, context.secrets.mailcowKey, context.fetch, this.mailcowBackoff)
      : null;
  }

  backoff(): { cloudflare: number; mailcow: number } {
    return { cloudflare: this.cloudflareBackoff.until, mailcow: this.mailcowBackoff.until };
  }

  // -------------------------------------------------------------------------
  // What every connection reaches
  // -------------------------------------------------------------------------

  async discover(): Promise<void> {
    const reports = await Promise.all(this.context.policy.connections.map(async (connection): Promise<ConnectionReport & { refs?: ZoneRef[] }> => {
      const report: ConnectionReport = { id: connection.id, label: connection.label, active: false, status: "missing", accounts: [], zones: 0, error: null };
      const api = this.cloudflare.get(connection.id);
      if (!api) return { ...report, error: "No token is saved for this connection" };
      try {
        const verified = await api.verify();
        report.status = verified.status;
        if (!verified.active) return { ...report, error: `Cloudflare reports this token as ${verified.status}` };
        const [zones, accounts] = await Promise.all([api.zones(), api.accounts()]);
        const known = new Map(accounts.map((account) => [account.id, account]));
        for (const zone of zones) if (!known.has(zone.account.id)) known.set(zone.account.id, zone.account);
        return { ...report, active: true, accounts: [...known.values()], zones: zones.length, refs: zones.map((zone) => ({ zone, connectionId: connection.id })) };
      } catch (error) {
        return { ...report, status: "error", error: reason(error) };
      }
    }));
    // In the configured order, not the order the reads finished: the first
    // connection reaching a zone is the one that writes it.
    for (const { refs, ...report } of reports) {
      if (refs) this.zoneRefs.push(...refs);
      this.connections.push(report);
    }
  }

  private connectionLabel(id: string): string {
    return this.context.policy.connections.find((connection) => connection.id === id)?.label ?? id;
  }

  /** The longest zone, across every connection, that the domain is in or under. */
  private resolve(domain: string, profile: Profile): Resolution {
    const matches = this.zoneRefs.filter(({ zone }) => !INACTIVE_ZONES.has(zone.status) && (domain === zone.name || domain.endsWith(`.${zone.name}`)));
    if (!matches.length) {
      const failed = this.connections.filter((connection) => !connection.active);
      if (!this.connections.length) return { kind: "unreachable", reason: "Add a Cloudflare connection first" };
      // A zone only a failed connection reaches would look missing, and be created again elsewhere.
      if (failed.length) return { kind: "unreachable", reason: `Cloudflare could not be read: ${failed.map((c) => c.error).join("; ")}` };
      const name = getDomain(domain, { allowPrivateDomains: false }) ?? domain;
      return { kind: "missing", name, createIn: profile.zone.createIn };
    }
    const longest = Math.max(...matches.map(({ zone }) => zone.name.length));
    const candidates = matches.filter(({ zone }) => zone.name.length === longest);
    const name = candidates[0]!.zone.name;
    const choice = this.context.policy.zoneChoices[name];
    const chosen = choice && candidates.find((ref) => ref.connectionId === choice.connectionId && ref.zone.id === choice.zoneId);
    if (chosen) return { kind: "zone", ref: chosen };
    const ids = new Set(candidates.map(({ zone }) => zone.id));
    // Two tokens reaching the same zone can both write it; the first connection is used until another is chosen.
    if (ids.size === 1) return { kind: "zone", ref: candidates[0]! };
    return { kind: "choose", candidates, name };
  }

  private profileOf(domain: string): Profile | null {
    const id = this.context.policy.assignments[domain];
    return this.context.policy.profiles.find((profile) => profile.id === id) ?? null;
  }

  /** Every assigned site's profile in each zone, so a zone's settings and rules are decided once. */
  private zoneProfiles(): Map<string, Profile[]> {
    if (this.profilesByZone) return this.profilesByZone;
    const byZone = new Map<string, Profile[]>();
    for (const site of this.context.sites) {
      const profile = this.profileOf(site.domain);
      if (!profile) continue;
      const resolved = this.resolve(site.domain, profile);
      if (resolved.kind !== "zone") continue;
      const list = byZone.get(resolved.ref.zone.id) ?? [];
      list.push(profile);
      byZone.set(resolved.ref.zone.id, list);
    }
    this.profilesByZone = byZone;
    return byZone;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private async loadZone(ref: ZoneRef, wants: ZoneWants): Promise<void> {
    const api = this.cloudflare.get(ref.connectionId)!;
    const state: ZoneState = this.zones.get(ref.zone.id) ?? { ref, records: null, settings: new Map(), rulesets: new Map(), error: null };
    this.zones.set(ref.zone.id, state);
    try {
      const settings = wantedSettings(wants).map((wanted) => wanted.setting).filter((setting) => !state.settings.has(setting));
      const phases = [...new Set(wantedRules(wants).map((rule) => rule.phase))].filter((phase) => !state.rulesets.has(phase));
      const [records, values, rulesets] = await Promise.all([
        state.records ?? api.records(ref.zone.id),
        Promise.all(settings.map((setting) => api.setting(ref.zone.id, setting))),
        Promise.all(phases.map((phase) => api.entrypoint(ref.zone.id, phase))),
      ]);
      state.records = records;
      settings.forEach((setting, index) => state.settings.set(setting, values[index]!));
      phases.forEach((phase, index) => state.rulesets.set(phase, rulesets[index]!));
    } catch (error) {
      state.error = reason(error);
    }
  }

  private dkimSelector(profile: Profile, mail: MailState | undefined): string | null {
    if (!profile.mailcow) return null;
    if (mail?.dkim) return mail.dkim.selector;
    const settings = this.context.policy.mailcow;
    if (!settings.dkimSource) return settings.dkimSelector;
    return this.sourceDkim && !("error" in this.sourceDkim) ? this.sourceDkim.selector : null;
  }

  private async loadMail(domains: string[]): Promise<void> {
    if (!this.mailcow) return;
    const api = this.mailcow;
    const settings = this.context.policy.mailcow;
    await Promise.all([
      ...domains.map(async (domain) => {
        try {
          const [exists, dkim] = await Promise.all([api.hasDomain(domain), api.dkim(domain)]);
          this.mail.set(domain, { exists, dkim });
        } catch (error) {
          this.mail.set(domain, { error: reason(error) });
        }
      }),
      (async () => {
        if (!settings.dkimSource || this.sourceDkim !== undefined) return;
        try {
          this.sourceDkim = await api.dkim(settings.dkimSource);
        } catch (error) {
          this.sourceDkim = { error: reason(error) };
        }
      })(),
      (async () => {
        if (!settings.sharedMailbox || this.acl.has(settings.sharedMailbox)) return;
        try {
          this.acl.set(settings.sharedMailbox, await api.senderAcl(settings.sharedMailbox));
        } catch (error) {
          this.acl.set(settings.sharedMailbox, { error: reason(error) });
        }
      })(),
    ]);
  }

  /** Reads what planning `domains` needs: their zones, those zones' settings and rules, and Mailcow. */
  async load(domains: string[]): Promise<void> {
    const byZone = this.zoneProfiles();
    const refs = new Map<string, ZoneRef>();
    const mailDomains: string[] = [];
    for (const domain of domains) {
      const profile = this.profileOf(domain);
      if (!profile) continue;
      const resolved = this.resolve(domain, profile);
      if (resolved.kind === "zone") refs.set(resolved.ref.zone.id, resolved.ref);
      if (profile.mailcow) mailDomains.push(domain);
    }
    await Promise.all([
      ...[...refs.values()].map((ref) => this.loadZone(ref, zoneWants(byZone.get(ref.zone.id) ?? []).wants)),
      this.loadMail(mailDomains),
    ]);
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  private vars(domain: string, zoneName: string, profile: Profile): SiteVars {
    const mail = this.mail.get(domain);
    const state = mail && !("error" in mail) ? mail : undefined;
    return {
      domain,
      zone: zoneName,
      ipv4: this.context.policy.server.ipv4 || this.context.addresses.ipv4,
      ipv6: this.context.policy.server.ipv6 || this.context.addresses.ipv6,
      mailcowHost: this.context.policy.mailcow.host,
      mailcowSelector: this.dkimSelector(profile, state),
      mailcowDkim: profile.mailcow ? state?.dkim?.txt ?? null : null,
    };
  }

  private zoneView(ref: ZoneRef): ZoneView {
    const { zone } = ref;
    return {
      id: zone.id, name: zone.name, status: zone.status, nameServers: zone.nameServers,
      account: zone.account.name || zone.account.id, connection: this.connectionLabel(ref.connectionId),
    };
  }

  private mailChanges(domain: string, profile: Profile, plan: SitePlan): void {
    const settings = this.context.policy.mailcow;
    if (!this.mailcow || !settings.host) {
      plan.problems.push("This profile sets up Mailcow; add Mailcow's address, API key and mail hostname first");
      return;
    }
    const mail = this.mail.get(domain);
    if (!mail) return;
    if ("error" in mail) {
      plan.problems.push(mail.error);
      return;
    }
    if (!mail.exists) plan.changes.push({ action: "create", subject: "Mailcow domain", detail: domain });
    if (!mail.dkim) {
      if (settings.dkimSource && this.sourceDkim && "error" in this.sourceDkim) plan.problems.push(this.sourceDkim.error);
      else if (settings.dkimSource && !this.sourceDkim) plan.problems.push(`Mailcow has no DKIM key for ${settings.dkimSource} to share`);
      else plan.changes.push({
        action: "create",
        subject: "Mailcow DKIM key",
        detail: settings.dkimSource ? `The key of ${settings.dkimSource}` : `A new ${settings.dkimBits}-bit key, selector ${settings.dkimSelector}`,
      });
    }
    if (!settings.sharedMailbox) return;
    const acl = this.acl.get(settings.sharedMailbox);
    if (acl === undefined) return;
    if (acl === null) {
      plan.changes.push({ action: "note", subject: "Mailcow sender permission", detail: `This Mailcow does not report ${settings.sharedMailbox}'s sender list; allow @${domain} there` });
    } else if ("error" in acl) {
      plan.changes.push({ action: "note", subject: "Mailcow sender permission", detail: acl.error });
    } else if (!aclAllows(acl, domain)) {
      plan.changes.push({ action: "update", subject: "Mailcow sender permission", detail: `${settings.sharedMailbox} may send as @${domain}` });
    }
  }

  private zoneChanges(state: ZoneState, wants: ZoneWants, plan: SitePlan): void {
    for (const wanted of wantedSettings(wants)) {
      const current = state.settings.get(wanted.setting);
      if (current === undefined || current === wanted.value) continue;
      const before = wanted.setting === "ssl" ? SSL_LABELS[current as keyof typeof SSL_LABELS] ?? current : current;
      plan.changes.push({ action: "update", subject: "Zone setting, whole zone", detail: wanted.label, before });
    }
    for (const spec of wantedRules(wants)) {
      if (!state.rulesets.has(spec.phase)) continue;
      const found = ruleState(state.rulesets.get(spec.phase) ?? null, spec.rule);
      if (found.state === "present") continue;
      plan.changes.push({ action: found.state, subject: "Cloudflare rule, whole zone", detail: spec.label });
    }
  }

  /** The plan for one site from what has been read. */
  planSite(site: PanelSite): SitePlan {
    const profile = this.profileOf(site.domain);
    const plan: SitePlan = {
      domain: site.domain, profileId: profile?.id ?? null, mode: profile?.mode ?? "report", zone: null,
      changes: [], problems: [], zoneChoices: [], certificateNames: [],
    };
    this.diffs.delete(site.domain);
    if (!profile) return plan;

    const resolved = this.resolve(site.domain, profile);
    if (resolved.kind === "unreachable") {
      plan.problems.push(resolved.reason);
      return plan;
    }
    if (resolved.kind === "choose") {
      plan.problems.push(`${resolved.name} is reachable through more than one connection; choose which one manages it`);
      plan.zoneChoices = resolved.candidates.map((ref) => ({
        zone: resolved.name, connectionId: ref.connectionId, zoneId: ref.zone.id,
        label: `${this.connectionLabel(ref.connectionId)} · ${ref.zone.account.name || ref.zone.account.id} (${ref.zone.status})`,
      }));
      return plan;
    }
    if (profile.records.some((row) => MAILCOW_PLACEHOLDER.test(row.name + row.content)) && !profile.mailcow) {
      plan.problems.push("Rows use {mailcow.…} placeholders, but the profile does not set up Mailcow");
      return plan;
    }
    plan.problems.push(...this.failures.get(site.domain) ?? []);
    if (profile.mailcow) this.mailChanges(site.domain, profile, plan);

    if (resolved.kind === "missing") {
      const { createIn } = resolved;
      const account = createIn && this.connections.find((c) => c.id === createIn.connectionId)?.accounts.find((a) => a.id === createIn.accountId);
      if (!createIn) plan.problems.push(`No Cloudflare connection reaches a zone for ${site.domain}; add ${resolved.name} to Cloudflare, or let the profile create it`);
      else if (!account) plan.problems.push("The account this profile creates zones in is not reachable; choose another in the profile");
      else {
        plan.changes.push({ action: "create", subject: "Cloudflare zone", detail: `${resolved.name} in ${account.name || account.id}; then set its nameservers at the registrar` });
        // A new zone is empty, so everything the profile wants is a record to create.
        const rendered = renderProfile(profile, this.vars(site.domain, resolved.name, profile));
        const diff = diffRecords(rendered, []);
        plan.problems.push(...diff.problems);
        for (const op of diff.ops) plan.changes.push(this.recordChange(op));
      }
      return plan;
    }

    const state = this.zones.get(resolved.ref.zone.id);
    plan.zone = this.zoneView(resolved.ref);
    if (!state?.records) {
      plan.problems.push(state?.error ?? "This zone has not been read yet");
      return plan;
    }
    if (state.error) plan.problems.push(state.error);

    // A profile that disagrees with what is enforced in its zone is stopped; Report only profiles never write, so
    // they do not stop anyone else. What the plan shows is what this site's own profile asks.
    const enforcing = (this.zoneProfiles().get(resolved.ref.zone.id) ?? []).filter((candidate) => candidate.mode === "enforce");
    plan.problems.push(...zoneWants([profile, ...enforcing]).problems);
    this.zoneChanges(state, zoneWants([profile]).wants, plan);

    const rendered = renderProfile(profile, this.vars(site.domain, resolved.ref.zone.name, profile));
    const diff = diffRecords(rendered, state.records);
    this.diffs.set(site.domain, diff);
    plan.problems.push(...diff.problems);
    for (const name of rendered.waitingDkim) {
      plan.changes.push({ action: "create", subject: `TXT ${name}`, detail: "Mailcow's DKIM key, once Mailcow holds it" });
    }
    for (const op of diff.ops) plan.changes.push(this.recordChange(op));
    const addresses = diff.wanted.filter((record) => ["A", "AAAA", "CNAME"].includes(record.type));
    plan.certificateNames = [site.domain, `www.${site.domain}`].filter((name) => addresses.some((record) => record.name === name));
    return plan;
  }

  private recordChange(op: RecordOp): Change {
    const subject = `${op.record.type} ${op.record.name}`;
    if (op.action === "update") return { action: "update", subject, detail: describeRecord(op.record), before: describeRecord(op.current!) };
    return { action: op.action, subject, detail: describeRecord(op.record) };
  }

  /** Plans every site, then marks sites in one zone whose profiles want different records at one name. */
  planAll(sites: PanelSite[]): SitePlan[] {
    const plans = sites.map((site) => this.planSite(site));
    const byZone = new Map<string, SitePlan[]>();
    for (const plan of plans) {
      if (plan.zone && this.diffs.has(plan.domain)) byZone.set(plan.zone.id, [...byZone.get(plan.zone.id) ?? [], plan]);
    }
    for (const group of byZone.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const clash = this.clash(group[i]!.domain, group[j]!.domain);
          if (!clash) continue;
          group[i]!.problems.push(`${group[j]!.domain} also manages ${clash} with different records`);
          group[j]!.problems.push(`${group[i]!.domain} also manages ${clash} with different records`);
        }
      }
    }
    return plans;
  }

  private clash(a: string, b: string): string | null {
    const left = this.diffs.get(a)!;
    const right = this.diffs.get(b)!;
    const atName = (diff: Diff, name: string) => diff.wanted.filter((record) => record.name === name).map(describeRecord).sort().join("\n");
    const names = new Set(left.wanted.map((record) => record.name));
    for (const name of right.wanted.map((record) => record.name)) {
      if (names.has(name) && atName(left, name) !== atName(right, name)) return name;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Enforcing
  // -------------------------------------------------------------------------

  private fail(domain: string, error: unknown): void {
    this.failures.set(domain, [...this.failures.get(domain) ?? [], reason(error)]);
  }

  /** Makes the given sites match their enforcing profiles. Sites with problems are left alone. */
  async enforce(sites: PanelSite[]): Promise<void> {
    const ready = () => this.planAll(this.context.sites)
      .filter((plan) => plan.mode === "enforce" && !plan.problems.length && sites.some((site) => site.domain === plan.domain));

    await this.createZones(ready());
    const targets = ready();
    if (!targets.length) return;
    const byZone = this.zoneProfiles();

    await Promise.all([...new Set(targets.map((plan) => plan.zone!.id))].map((zoneId) => {
      const domains = targets.filter((plan) => plan.zone!.id === zoneId).map((plan) => plan.domain);
      return this.enforceZone(this.zones.get(zoneId)!, byZone.get(zoneId) ?? [], domains);
    }));
    await this.enforceMail(targets.filter((plan) => this.profileOf(plan.domain)?.mailcow).map((plan) => plan.domain));

    const after = ready();
    await Promise.all([...new Set(after.map((plan) => plan.zone!.id))].map(async (zoneId) => {
      const state = this.zones.get(zoneId)!;
      // One zone's writes go in order; zones are independent of each other.
      for (const plan of after.filter((candidate) => candidate.zone!.id === zoneId)) {
        try {
          // Planned again, since an earlier site in the zone may have written a record this one wants too.
          const fresh = this.planSite(this.context.sites.find((site) => site.domain === plan.domain)!);
          if (fresh.problems.length) continue;
          await this.applyRecords(state, this.diffs.get(plan.domain)!.ops);
        } catch (error) {
          this.fail(plan.domain, error);
        }
      }
    }));
  }

  private async createZones(plans: SitePlan[]): Promise<void> {
    const wanted = new Map<string, { createIn: AccountRef; domains: string[] }>();
    for (const plan of plans) {
      const profile = this.profileOf(plan.domain)!;
      const resolved = this.resolve(plan.domain, profile);
      if (resolved.kind !== "missing" || !resolved.createIn) continue;
      const entry = wanted.get(resolved.name) ?? { createIn: resolved.createIn, domains: [] };
      entry.domains.push(plan.domain);
      wanted.set(resolved.name, entry);
    }
    await Promise.all([...wanted].map(async ([name, { createIn, domains }]) => {
      try {
        const zone = await this.cloudflare.get(createIn.connectionId)!.createZone(createIn.accountId, name);
        const ref = { zone, connectionId: createIn.connectionId };
        this.zoneRefs.push(ref);
        this.profilesByZone = null;
        this.zones.set(zone.id, { ref, records: null, settings: new Map(), rulesets: new Map(), error: null });
        await this.loadZone(ref, zoneWants(domains.map((domain) => this.profileOf(domain)!)).wants);
      } catch (error) {
        for (const domain of domains) this.fail(domain, error);
      }
    }));
  }

  private async enforceZone(state: ZoneState, profiles: Profile[], domains: string[]): Promise<void> {
    const api = this.cloudflare.get(state.ref.connectionId)!;
    const zoneId = state.ref.zone.id;
    // A Report only profile in the same zone is never a reason to write.
    const { wants, problems } = zoneWants(profiles.filter((profile) => profile.mode === "enforce"));
    if (problems.length) return;
    try {
      for (const wanted of wantedSettings(wants)) {
        if (state.settings.get(wanted.setting) === wanted.value) continue;
        await api.setSetting(zoneId, wanted.setting, wanted.value);
        state.settings.set(wanted.setting, wanted.value);
      }
      // Rules before records, so a proxied record never exists without the rule its certificate needs.
      for (const spec of wantedRules(wants)) {
        const ruleset = state.rulesets.get(spec.phase) ?? null;
        const found = ruleState(ruleset, spec.rule);
        if (found.state === "present") continue;
        let updated: CfRuleset;
        if (!ruleset) updated = await api.createEntrypoint(zoneId, spec.phase, [spec.rule]);
        else if (found.state === "update") updated = await api.updateRule(zoneId, ruleset.id, found.ruleId, spec.rule);
        else updated = await api.addRule(zoneId, ruleset.id, spec.rule);
        state.rulesets.set(spec.phase, updated);
      }
    } catch (error) {
      for (const domain of domains) this.fail(domain, error);
    }
  }

  private async enforceMail(domains: string[]): Promise<void> {
    const api = this.mailcow;
    if (!api || !domains.length) return;
    const settings = this.context.policy.mailcow;
    const ok: string[] = [];
    await Promise.all(domains.map(async (domain) => {
      const state = this.mail.get(domain);
      if (!state || "error" in state) return;
      try {
        if (!state.exists) {
          await api.addDomain(domain);
          state.exists = await api.hasDomain(domain);
          if (!state.exists) throw new ProviderError("Mailcow", `did not keep the domain ${domain}`);
        }
        if (!state.dkim) {
          if (settings.dkimSource) await api.duplicateDkim(settings.dkimSource, domain);
          else await api.generateDkim(domain, settings.dkimSelector, settings.dkimBits);
          state.dkim = await api.dkim(domain);
          if (!state.dkim) throw new ProviderError("Mailcow", `did not return the DKIM key it made for ${domain}`);
        }
        ok.push(domain);
      } catch (error) {
        this.fail(domain, error);
      }
    }));

    const mailbox = settings.sharedMailbox;
    if (!mailbox || !ok.length) return;
    try {
      const acl = await api.senderAcl(mailbox);
      if (acl === null) return;
      const missing = ok.filter((domain) => !aclAllows(acl, domain));
      if (!missing.length) return;
      await api.setSenderAcl(mailbox, [...acl, ...missing.map((domain) => `@${domain}`)]);
      const after = await api.senderAcl(mailbox);
      this.acl.set(mailbox, after);
      const refused = missing.filter((domain) => !after || !aclAllows(after, domain));
      for (const domain of refused) this.fail(domain, new ProviderError("Mailcow", `did not let ${mailbox} send as @${domain}`));
    } catch (error) {
      for (const domain of ok) this.fail(domain, error);
    }
  }

  private async applyRecords(state: ZoneState, ops: RecordOp[]): Promise<void> {
    const api = this.cloudflare.get(state.ref.connectionId)!;
    const zoneId = state.ref.zone.id;
    for (const op of ops) {
      if (op.action === "delete") {
        await api.deleteRecord(zoneId, op.current!.id);
        state.records = state.records!.filter((record) => record.id !== op.current!.id);
      } else if (op.action === "update") {
        const record = await api.updateRecord(zoneId, op.current!.id, op.record);
        state.records = state.records!.map((current) => current.id === record.id ? record : current);
      } else {
        const record = await api.createRecord(zoneId, op.record, RECORD_COMMENT);
        state.records = [...state.records!, record];
      }
    }
  }

  // -------------------------------------------------------------------------
  // What the run leaves behind
  // -------------------------------------------------------------------------

  /** The records an enforcing site has exactly as wanted, to recognise them once the site is gone. */
  managed(plans: SitePlan[]): Record<string, ManagedRecords> {
    const result: Record<string, ManagedRecords> = {};
    for (const plan of plans) {
      const diff = this.diffs.get(plan.domain);
      if (plan.mode !== "enforce" || !plan.zone || !diff || !diff.matched.length) continue;
      const state = this.zones.get(plan.zone.id)!;
      result[plan.domain] = {
        zoneId: plan.zone.id,
        zoneName: plan.zone.name,
        connectionId: state.ref.connectionId,
        records: diff.matched.map((record) => ({ ...record })),
      };
    }
    return result;
  }

  /** Whether any current site's profile writes at a record's name and type, so removing an orphan never takes it. */
  stillWanted(record: Pick<CfRecord, "name">): boolean {
    return [...this.diffs.values()].some((diff) => diff.names.includes(record.name));
  }

  /** Whether a zone some current site is in could not be read, so what its sites want is unknown. */
  unread(zoneId: string): boolean {
    const state = this.zones.get(zoneId);
    return state !== undefined && (state.records === null || state.error !== null);
  }

  /** The zone's records, read now, through the connection that tracked them. */
  async readZone(connectionId: string, zoneId: string): Promise<CfRecord[]> {
    const api = this.cloudflare.get(connectionId);
    if (!api) throw new Error("The connection these records were tracked through has been removed");
    return api.records(zoneId);
  }

  async deleteRecords(connectionId: string, zoneId: string, ids: string[]): Promise<void> {
    const api = this.cloudflare.get(connectionId)!;
    for (const id of ids) await api.deleteRecord(zoneId, id);
  }
}

/** Whether a new site's certificate can be requested now, and if not, why. */
export function readiness(plan: SitePlan | undefined): { ready: boolean; reason: string } {
  if (!plan?.profileId) return { ready: false, reason: "No DNS profile is assigned to this site" };
  if (plan.mode !== "enforce") return { ready: false, reason: "Its DNS profile is Report only" };
  if (plan.problems.length) return { ready: false, reason: plan.problems.join("; ") };
  if (!plan.zone) return { ready: false, reason: "Its Cloudflare zone is being created" };
  if (plan.zone.status !== "active") {
    const servers = plan.zone.nameServers.length ? `: ${plan.zone.nameServers.join(", ")}` : "";
    return { ready: false, reason: `Zone ${plan.zone.name} is ${plan.zone.status}; set its nameservers at the registrar${servers}` };
  }
  if (plan.changes.some((change) => change.action !== "note")) return { ready: false, reason: "Some DNS changes have not been made yet" };
  if (!plan.certificateNames.includes(plan.domain)) return { ready: false, reason: "The profile manages no address for this site" };
  return { ready: true, reason: "DNS is in place" };
}
