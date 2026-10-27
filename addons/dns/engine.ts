/**
 * One pass over Cloudflare and Mailcow: find what every connection can reach,
 * read the zones the fleet's sites live in, work out each site's plan, and --
 * once DNS is Automatic -- carry it out.
 *
 * Planning is synchronous over what was read, so the same pass can plan,
 * write, and plan again for its report without reading everything twice.
 */
import { getDomain } from "tldts";
import type { Addresses } from "./addresses";
import { CloudflareApi, type CfAccount, type CfRecord, type CfRuleset, type CfZone } from "./cloudflare";
import { type ApiFetch, ProviderError } from "./http";
import { aclAllows, MailcowApi, type MailcowDkim } from "./mailcow";
import type { AccountRef, Policy, Profile, Redirect, Secrets } from "./model";
import { describeRecord, diffRecords, renderProfile, renderRedirect, type Diff, type RecordOp, type Rendered, type SiteVars } from "./records";
import {
  describeRedirect, foundRedirect, PLACEHOLDER, REDIRECT_PHASE, redirectAction, redirectHosts, redirectRef, redirectRuleState, standInHosts, wantedRedirectRule,
  type FoundRedirect,
} from "./redirects";
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
  /** Set for a redirect domain, which is planned beside the sites but is not one. */
  redirect?: Redirect;
}

/** What a stand-in site on this server redirects to now. */
export type StandIn = Pick<Redirect, "target" | "status" | "keepPath" | "keepQuery">;

/** The CloudPanel sites that serve redirects while no Cloudflare connection is set up. */
export interface StandIns {
  current: Record<string, StandIn>;
  create(redirect: Redirect): Promise<void>;
  update(redirect: Redirect): Promise<void>;
  remove(source: string): Promise<void>;
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
  /** Waits for an administrator: a new site's change beyond pointing its own names here. */
  waits?: true;
}

/** One write DNS made, for the page's change log. */
export interface LogEntry {
  at: string;
  /** The sites the write was for; empty for a zone-wide one. */
  sites: string[];
  zone: string;
  action: "create" | "update" | "delete";
  subject: string;
  detail: string;
  before?: string;
}

export interface SitePlan {
  domain: string;
  profileId: string | null;
  /** Whether DNS writes this plan: Automatic, or a review being confirmed. */
  mode: "report" | "enforce";
  zone: ZoneView | null;
  changes: Change[];
  /** What keeps this site from being planned or enforced at all. */
  problems: string[];
  /** Where two connections reach this site's zone and one has to be chosen. */
  zoneChoices: { zone: string; connectionId: string; zoneId: string; label: string }[];
  /** The names a certificate can be requested for once DNS is in place. */
  certificateNames: string[];
  /** A new site whose other changes wait for an administrator's review. */
  held?: true;
  /** A redirect domain; `zone` is null while it is served by a stand-in site on this server. */
  redirect?: true;
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
  standIns?: StandIns;
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
  | { kind: "missing"; name: string; createIn: AccountRef | null; accounts: number }
  | { kind: "choose"; candidates: ZoneRef[]; name: string; lost?: boolean }
  | { kind: "unreachable"; reason: string };

const INACTIVE_ZONES = new Set(["moved", "deleted", "deactivated"]);
const MAILCOW_PLACEHOLDER = /\{mailcow\./;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DnsRun {
  readonly connections: ConnectionReport[] = [];
  /** What this run wrote, in the order it was written. */
  readonly log: LogEntry[] = [];
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
  private readonly held: Set<string>;
  /** CloudPanel's sites, then the redirect domains. */
  readonly entries: PanelSite[];
  private readonly redirects: Map<string, Redirect>;
  private readonly siteDomains: Set<string>;

  constructor(private readonly context: RunContext) {
    this.redirects = new Map(context.policy.redirects.map((redirect) => [redirect.source, redirect]));
    this.siteDomains = new Set(context.sites.map((site) => site.domain));
    this.entries = [
      ...context.sites.filter((site) => !this.redirects.has(site.domain)),
      ...context.policy.redirects.map((redirect) => ({
        id: 0, domain: redirect.source, type: "redirect", createdAt: 0, selfSigned: false, cloudflareOnly: false, redirect,
      })),
    ];
    this.cloudflareBackoff = { until: context.backoff.cloudflare };
    this.mailcowBackoff = { until: context.backoff.mailcow };
    this.held = new Set(context.policy.held);
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
  private resolve(domain: string): Resolution {
    const matches = this.zoneRefs.filter(({ zone }) => !INACTIVE_ZONES.has(zone.status) && (domain === zone.name || domain.endsWith(`.${zone.name}`)));
    if (!matches.length) {
      const failed = this.connections.filter((connection) => !connection.active);
      if (!this.connections.length) return { kind: "unreachable", reason: "Add a Cloudflare connection first" };
      // A zone only a failed connection reaches would look missing, and be created again elsewhere.
      if (failed.length) return { kind: "unreachable", reason: `Cloudflare could not be read: ${failed.map((c) => c.error).join("; ")}` };
      const name = getDomain(domain, { allowPrivateDomains: false }) ?? domain;
      const accounts = this.connections.flatMap((connection) => connection.accounts.map((account) => ({ connectionId: connection.id, accountId: account.id })));
      const unique = new Set(accounts.map((account) => account.accountId));
      return { kind: "missing", name, createIn: this.context.policy.createIn ?? (unique.size === 1 ? accounts[0]! : null), accounts: unique.size };
    }
    const longest = Math.max(...matches.map(({ zone }) => zone.name.length));
    const candidates = matches.filter(({ zone }) => zone.name.length === longest);
    const name = candidates[0]!.zone.name;
    const choice = this.context.policy.zoneChoices[name];
    const chosen = choice && candidates.find((ref) => ref.connectionId === choice.connectionId && ref.zone.id === choice.zoneId);
    if (chosen) return { kind: "zone", ref: chosen };
    const same = choice && candidates.find((ref) => ref.zone.id === choice.zoneId);
    if (same) return { kind: "zone", ref: same };
    // The chosen zone is out of reach, and what is left is a zone the operator did not pick.
    if (choice) return { kind: "choose", candidates, name, lost: true };
    const ids = new Set(candidates.map(({ zone }) => zone.id));
    // Two tokens reaching the same zone can both write it; the first connection is used until another is chosen.
    if (ids.size === 1) return { kind: "zone", ref: candidates[0]! };
    return { kind: "choose", candidates, name };
  }

  /** No connection means nothing in Cloudflare is DNS's, and redirects are served from this server. */
  private onServer(): boolean {
    return this.context.policy.connections.length === 0;
  }

  /** The domains a check plans: sites in a profile, and every redirect domain. */
  plannedDomains(): string[] {
    return this.entries.filter((entry) => entry.redirect || this.profileOf(entry.domain)).map((entry) => entry.domain);
  }

  private profileOf(domain: string): Profile | null {
    const redirect = this.redirects.get(domain);
    const id = redirect ? redirect.profileId : this.context.policy.assignments[domain];
    return this.context.policy.profiles.find((profile) => profile.id === id) ?? null;
  }

  /** Every assigned site's profile in each zone, so a zone's settings and rules are decided once. */
  private zoneProfiles(withHeld = true): Map<string, Profile[]> {
    if (withHeld && this.profilesByZone) return this.profilesByZone;
    const byZone = new Map<string, Profile[]>();
    for (const site of this.entries) {
      const profile = this.profileOf(site.domain);
      if (!profile || (!withHeld && this.held.has(site.domain))) continue;
      if (site.redirect && this.onServer()) continue;
      const resolved = this.resolve(site.domain);
      if (resolved.kind !== "zone") continue;
      const list = byZone.get(resolved.ref.zone.id) ?? [];
      list.push(profile);
      byZone.set(resolved.ref.zone.id, list);
    }
    if (withHeld) this.profilesByZone = byZone;
    return byZone;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private async loadZone(ref: ZoneRef, wants: ZoneWants, redirects = false): Promise<void> {
    const api = this.cloudflare.get(ref.connectionId)!;
    const state: ZoneState = this.zones.get(ref.zone.id) ?? { ref, records: null, settings: new Map(), rulesets: new Map(), error: null };
    this.zones.set(ref.zone.id, state);
    try {
      const settings = wantedSettings(wants).map((wanted) => wanted.setting).filter((setting) => !state.settings.has(setting));
      const phases = [...new Set([...wantedRules(wants).map((rule) => rule.phase), ...redirects ? [REDIRECT_PHASE] : []])]
        .filter((phase) => !state.rulesets.has(phase));
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

  private dkimSelector(profile: Profile | null, mail: MailState | undefined): string | null {
    if (!profile?.mailcow) return null;
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
    const redirectZones = new Set<string>();
    const mailDomains: string[] = [];
    for (const domain of domains) {
      const profile = this.profileOf(domain);
      const redirect = this.redirects.has(domain);
      if (!profile && !redirect) continue;
      if (redirect && this.onServer()) continue;
      const resolved = this.resolve(domain);
      if (resolved.kind === "zone") {
        refs.set(resolved.ref.zone.id, resolved.ref);
        if (redirect) redirectZones.add(resolved.ref.zone.id);
      }
      if (profile?.mailcow) mailDomains.push(domain);
    }
    await Promise.all([
      ...[...refs.values()].map((ref) => this.loadZone(ref, zoneWants(byZone.get(ref.zone.id) ?? []).wants, redirectZones.has(ref.zone.id))),
      this.loadMail(mailDomains),
    ]);
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  private vars(domain: string, zoneName: string, profile: Profile | null): SiteVars {
    const mail = this.mail.get(domain);
    const state = mail && !("error" in mail) ? mail : undefined;
    return {
      domain,
      zone: zoneName,
      ipv4: this.context.policy.server.ipv4 || this.context.addresses.ipv4,
      ipv6: this.context.policy.server.ipv6 || this.context.addresses.ipv6,
      mailcowHost: this.context.policy.mailcow.host,
      mailcowSelector: this.dkimSelector(profile, state),
      mailcowDkim: profile?.mailcow ? state?.dkim?.txt ?? null : null,
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
      plan.problems.push("This profile sets up Mailcow; set up Mailcow's hostname and API key first");
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
      plan.changes.push({ action: "update", subject: "Zone setting, whole zone", detail: wanted.label, before, ...plan.held && { waits: true } });
    }
    for (const spec of wantedRules(wants)) {
      if (!state.rulesets.has(spec.phase)) continue;
      const found = ruleState(state.rulesets.get(spec.phase) ?? null, spec.rule);
      if (found.state === "present") continue;
      plan.changes.push({ action: found.state, subject: "Cloudflare rule, whole zone", detail: spec.label });
    }
  }

  /** The plan for one site, or one redirect domain, from what has been read. */
  planSite(site: PanelSite): SitePlan {
    const plan = this.planEntry(site);
    // A redirect domain held after a connection arrived waits for its review as a whole.
    if (site.redirect && plan.held) plan.changes = plan.changes.map((change) => change.action === "note" ? change : { ...change, waits: true });
    return plan;
  }

  private planEntry(site: PanelSite): SitePlan {
    const { redirect } = site;
    const profile = this.profileOf(site.domain);
    const plan: SitePlan = {
      domain: site.domain, profileId: profile?.id ?? null, mode: this.context.policy.automatic ? "enforce" : "report", zone: null,
      changes: [], problems: [], zoneChoices: [], certificateNames: [], ...redirect && { redirect: true as const },
    };
    this.diffs.delete(site.domain);
    if (!profile && !redirect) return plan;
    if (this.held.has(site.domain)) plan.held = true;
    if (redirect && this.siteDomains.has(site.domain)) {
      plan.problems.push(`CloudPanel has a site ${site.domain}; delete the site or this redirect`);
      return plan;
    }
    if (redirect && this.onServer()) return this.planStandIn(redirect, profile, plan);

    const resolved = this.resolve(site.domain);
    if (resolved.kind === "unreachable") {
      plan.problems.push(resolved.reason);
      return plan;
    }
    if (resolved.kind === "choose") {
      plan.problems.push(resolved.lost
        ? `The zone chosen for ${resolved.name} cannot be reached; check its connection, or choose again`
        : `${resolved.name} is reachable through more than one connection; choose which one manages it`);
      plan.zoneChoices = resolved.candidates.map((ref) => ({
        zone: resolved.name, connectionId: ref.connectionId, zoneId: ref.zone.id,
        label: `${this.connectionLabel(ref.connectionId)} · ${ref.zone.account.name || ref.zone.account.id} (${ref.zone.status})`,
      }));
      return plan;
    }
    if (profile && profile.records.some((row) => MAILCOW_PLACEHOLDER.test(row.name + row.content)) && !profile.mailcow) {
      plan.problems.push("Rows use {mailcow.…} placeholders, but the profile does not set up Mailcow");
      return plan;
    }
    plan.problems.push(...this.failures.get(site.domain) ?? []);
    if (profile?.mailcow) this.mailChanges(site.domain, profile, plan);
    const render = (zoneName: string): Rendered => redirect
      ? renderRedirect(profile, redirectHosts(redirect.source, zoneName), this.vars(site.domain, zoneName, profile), PLACEHOLDER)
      : renderProfile(profile!, this.vars(site.domain, zoneName, profile));

    if (resolved.kind === "missing") {
      const { createIn } = resolved;
      const account = createIn && this.connections.find((c) => c.id === createIn.connectionId)?.accounts.find((a) => a.id === createIn.accountId);
      if (!createIn) {
        plan.problems.push(resolved.accounts
          ? `${resolved.name} is not in Cloudflare; choose the account for new zones under Settings`
          : `${resolved.name} is not in Cloudflare, and no connection reaches an account to create it in`);
      } else if (!account) plan.problems.push("The account for new zones is not reachable; choose another under Settings");
      else {
        plan.changes.push({ action: "create", subject: "Cloudflare zone", detail: `${resolved.name} in ${account.name || account.id}; then set its nameservers at the registrar` });
        if (redirect) {
          const hosts = redirectHosts(redirect.source, resolved.name);
          plan.changes.push({ action: "create", subject: "Cloudflare redirect rule", detail: `${hosts.join(" and ")}: ${describeRedirect(redirect)}` });
        }
        // A new zone is empty, so everything the profile wants is a record to create.
        const diff = diffRecords(render(resolved.name), []);
        plan.problems.push(...diff.problems);
        for (const op of diff.ops) plan.changes.push(this.recordChange(op));
        if (redirect) this.standInChange(redirect.source, resolved.name, false, plan);
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

    // A profile that disagrees with another in its zone is stopped. What the plan shows is what this site's own profile asks.
    const own = profile ? [profile] : [];
    plan.problems.push(...zoneWants([...own, ...this.zoneProfiles().get(resolved.ref.zone.id) ?? []]).problems);
    this.zoneChanges(state, zoneWants(own).wants, plan);
    if (redirect) this.redirectRuleChange(state, redirect, plan);

    const rendered = render(resolved.ref.zone.name);
    const diff = diffRecords(rendered, state.records);
    this.diffs.set(site.domain, diff);
    plan.problems.push(...diff.problems);
    for (const name of rendered.waitingDkim) {
      plan.changes.push({ action: "create", subject: `TXT ${name}`, detail: "Mailcow's DKIM key, once Mailcow holds it" });
    }
    for (const op of diff.ops) {
      const change = this.recordChange(op);
      plan.changes.push(plan.held && !redirect && !pointsOwnName(site.domain, op) ? { ...change, waits: true } : change);
    }
    if (redirect) {
      this.standInChange(redirect.source, resolved.ref.zone.name, resolved.ref.zone.status === "active", plan);
      return plan;
    }
    const addresses = diff.wanted.filter((record) => ["A", "AAAA", "CNAME"].includes(record.type));
    plan.certificateNames = [site.domain, `www.${site.domain}`].filter((name) => addresses.some((record) => record.name === name));
    return plan;
  }

  /** A redirect served from this server, while DNS has no Cloudflare connection. */
  private planStandIn(redirect: Redirect, profile: Profile | null, plan: SitePlan): SitePlan {
    const current = this.context.standIns?.current[redirect.source];
    if (!current) {
      plan.changes.push({
        action: "create", subject: "Stand-in site",
        detail: `A static site on this server for ${standInHosts(redirect.source).join(" and ")}: ${describeRedirect(redirect)}`,
      });
    } else if (describeRedirect(current) !== describeRedirect(redirect)) {
      plan.changes.push({ action: "update", subject: "Stand-in site", detail: describeRedirect(redirect), before: describeRedirect(current) });
    }
    if (profile) plan.changes.push({ action: "note", subject: "Profile", detail: "Its records apply once a Cloudflare connection reaches this domain" });
    return plan;
  }

  private standInChange(source: string, zone: string, active: boolean, plan: SitePlan): void {
    if (!this.context.standIns?.current[source]) return;
    plan.changes.push({
      action: "delete", subject: "Stand-in site",
      detail: active ? "Deleted once the redirect is in Cloudflare" : `Deleted once the redirect is in Cloudflare and ${zone} is active`,
    });
  }

  private redirectRuleChange(state: ZoneState, redirect: Redirect, plan: SitePlan): void {
    if (!state.rulesets.has(REDIRECT_PHASE)) return;
    const hosts = redirectHosts(redirect.source, state.ref.zone.name);
    const found = redirectRuleState(state.rulesets.get(REDIRECT_PHASE) ?? null, redirect, hosts);
    const detail = `${hosts.join(" and ")}: ${describeRedirect(redirect)}`;
    if (found.state === "problem") plan.problems.push(found.problem);
    else if (found.state === "create") plan.changes.push({ action: "create", subject: "Cloudflare redirect rule", detail });
    else if (found.state === "update") {
      const action = redirectAction(found.rule);
      const before = [
        action ? describeRedirect(action) : found.rule.expression,
        / and not starts_with\(http\.request\.uri\.path, "\/\.well-known\/acme-challenge\/"\)\s*$/.test(found.rule.expression) && "except Let's Encrypt checks",
        !found.rule.enabled && "disabled",
        found.rule.ref !== redirectRef(redirect.source) && "another tool's rule, taken over in place",
      ].filter(Boolean).join(" · ");
      plan.changes.push({ action: "update", subject: "Cloudflare redirect rule", detail, before });
    }
  }

  private recordChange(op: RecordOp): Change {
    const subject = `${op.record.type} ${op.record.name}`;
    if (op.action === "update") return { action: "update", subject, detail: describeRecord(op.record), before: describeRecord(op.current!) };
    return { action: op.action, subject, detail: describeRecord(op.record) };
  }

  /** Plans every site and redirect domain, then marks those in one zone whose profiles want different records at one name. */
  planAll(): SitePlan[] {
    const plans = this.entries.map((site) => this.planSite(site));
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

  /**
   * Holds those of `domains` whose plans do more than point their own names
   * here and add records, or could not be planned yet, and answers which. Call
   * after `load`.
   */
  holdForReview(domains: string[]): string[] {
    return domains.filter((domain) => {
      const site = this.entries.find((candidate) => candidate.domain === domain);
      if (!site || this.held.has(domain)) return false;
      this.held.add(domain);
      const plan = this.planSite(site);
      // A site whose zone could not be read is held until a check can say what it would change.
      if (plan.problems.length || plan.changes.some((change) => change.waits)) return true;
      this.held.delete(domain);
      return false;
    });
  }

  /** Releases the held sites a clean plan shows have nothing beyond their own names to change, and answers which. */
  releaseHeld(): string[] {
    return [...this.held].filter((domain) => {
      const site = this.entries.find((candidate) => candidate.domain === domain);
      if (!site) return false;
      const plan = this.planSite(site);
      if (plan.problems.length || plan.changes.some((change) => change.waits)) return false;
      this.held.delete(domain);
      return true;
    });
  }

  /**
   * Makes the given sites and redirect domains match once DNS is Automatic.
   * Those with problems are left alone, and so is a redirect domain held for
   * its review.
   */
  async enforce(domains: string[]): Promise<void> {
    const ready = () => this.planAll()
      .filter((plan) => plan.mode === "enforce" && !plan.problems.length && domains.includes(plan.domain) && !(plan.redirect && plan.held));

    if (this.onServer()) {
      await this.enforceStandIns(ready().filter((plan) => plan.redirect));
      return;
    }
    await this.createZones(ready());
    const targets = ready().filter((plan) => plan.zone);
    if (!targets.length) return;
    const byZone = this.zoneProfiles();
    const reviewed = this.zoneProfiles(false);

    await Promise.all([...new Set(targets.map((plan) => plan.zone!.id))].map((zoneId) => {
      const domains = targets.filter((plan) => plan.zone!.id === zoneId).map((plan) => plan.domain);
      return this.enforceZone(this.zones.get(zoneId)!, byZone.get(zoneId) ?? [], reviewed.get(zoneId) ?? [], domains);
    }));
    await this.enforceMail(targets.filter((plan) => this.profileOf(plan.domain)?.mailcow).map((plan) => plan.domain));

    const after = ready();
    await Promise.all([...new Set(after.map((plan) => plan.zone!.id))].map(async (zoneId) => {
      const state = this.zones.get(zoneId)!;
      // One zone's writes go in order; zones are independent of each other.
      for (const plan of after.filter((candidate) => candidate.zone!.id === zoneId)) {
        try {
          // Planned again, since an earlier site in the zone may have written a record this one wants too.
          const entry = this.entries.find((site) => site.domain === plan.domain)!;
          const fresh = this.planSite(entry);
          if (fresh.problems.length) continue;
          // The redirect before its placeholder, so the placeholder never answers on its own.
          if (entry.redirect) await this.enforceRedirectRule(state, entry.redirect);
          const ops = this.diffs.get(plan.domain)!.ops;
          await this.applyRecords(state, fresh.held ? ops.filter((op) => pointsOwnName(plan.domain, op)) : ops, plan.domain);
          if (entry.redirect) await this.retireStandIn(state, entry.redirect);
        } catch (error) {
          this.fail(plan.domain, error);
        }
      }
    }));
  }

  private async createZones(plans: SitePlan[]): Promise<void> {
    const wanted = new Map<string, { createIn: AccountRef; domains: string[] }>();
    const accountName = (ref: AccountRef) => this.connections.find((c) => c.id === ref.connectionId)?.accounts.find((a) => a.id === ref.accountId)?.name || ref.accountId;
    for (const plan of plans) {
      const resolved = this.resolve(plan.domain);
      if (resolved.kind !== "missing" || !resolved.createIn) continue;
      const entry = wanted.get(resolved.name) ?? { createIn: resolved.createIn, domains: [] };
      entry.domains.push(plan.domain);
      wanted.set(resolved.name, entry);
    }
    await Promise.all([...wanted].map(async ([name, { createIn, domains }]) => {
      try {
        const zone = await this.cloudflare.get(createIn.connectionId)!.createZone(createIn.accountId, name);
        this.logged(domains, name, "create", "Cloudflare zone",
          `In ${accountName(createIn)}${zone.nameServers.length ? `; nameservers ${zone.nameServers.join(", ")}` : ""}`);
        const ref = { zone, connectionId: createIn.connectionId };
        this.zoneRefs.push(ref);
        this.profilesByZone = null;
        this.zones.set(zone.id, { ref, records: null, settings: new Map(), rulesets: new Map(), error: null });
        const profiles = domains.map((domain) => this.profileOf(domain)).filter((profile) => profile !== null);
        await this.loadZone(ref, zoneWants(profiles).wants, domains.some((domain) => this.redirects.has(domain)));
      } catch (error) {
        for (const domain of domains) this.fail(domain, error);
      }
    }));
  }

  /** `reviewed` leaves out held sites' profiles: their rules are written, their zone settings wait. */
  private async enforceZone(state: ZoneState, profiles: Profile[], reviewed: Profile[], domains: string[]): Promise<void> {
    const api = this.cloudflare.get(state.ref.connectionId)!;
    const zoneId = state.ref.zone.id;
    const { wants, problems } = zoneWants(profiles);
    if (problems.length) return;
    const zone = state.ref.zone.name;
    try {
      for (const wanted of wantedSettings(zoneWants(reviewed).wants)) {
        const current = state.settings.get(wanted.setting);
        if (current === wanted.value) continue;
        await api.setSetting(zoneId, wanted.setting, wanted.value);
        state.settings.set(wanted.setting, wanted.value);
        const before = current === undefined ? undefined : wanted.setting === "ssl" ? SSL_LABELS[current as keyof typeof SSL_LABELS] ?? current : current;
        this.logged([], zone, "update", "Zone setting, whole zone", wanted.label, before);
      }
      // Rules before records, so a proxied record never exists without the rule its certificate needs.
      for (const spec of wantedRules(wants)) {
        const ruleset = state.rulesets.get(spec.phase) ?? null;
        const found = ruleState(ruleset, spec.rule);
        if (found.state === "present") continue;
        let updated: CfRuleset;
        if (!ruleset) updated = await api.createEntrypoint(zoneId, spec.phase, [spec.rule]);
        else if (found.state === "update") updated = await api.updateRule(zoneId, spec.phase, ruleset.id, found.ruleId, spec.rule);
        else updated = await api.addRule(zoneId, spec.phase, ruleset.id, spec.rule);
        state.rulesets.set(spec.phase, updated);
        this.logged([], zone, found.state === "update" ? "update" : "create", "Cloudflare rule, whole zone", spec.label);
      }
    } catch (error) {
      for (const domain of domains) this.fail(domain, error);
    }
  }

  private async enforceRedirectRule(state: ZoneState, redirect: Redirect): Promise<void> {
    const api = this.cloudflare.get(state.ref.connectionId)!;
    const zoneId = state.ref.zone.id;
    const hosts = redirectHosts(redirect.source, state.ref.zone.name);
    const ruleset = state.rulesets.get(REDIRECT_PHASE) ?? null;
    const found = redirectRuleState(ruleset, redirect, hosts);
    if (found.state === "present" || found.state === "problem") return;
    const wanted = wantedRedirectRule(redirect, hosts);
    let updated: CfRuleset;
    if (!ruleset) updated = await api.createEntrypoint(zoneId, REDIRECT_PHASE, [wanted]);
    else if (found.state === "create") updated = await api.addRule(zoneId, REDIRECT_PHASE, ruleset.id, wanted);
    else {
      try {
        updated = await api.updateRule(zoneId, REDIRECT_PHASE, ruleset.id, found.rule.id, wanted);
      } catch (error) {
        // Should Cloudflare keep a rule's own ref, the rule is still found by its hosts on every check.
        if (!(error instanceof ProviderError) || error.status !== 400 || !found.rule.ref || found.rule.ref === wanted.ref) throw error;
        updated = await api.updateRule(zoneId, REDIRECT_PHASE, ruleset.id, found.rule.id, { ...wanted, ref: found.rule.ref });
      }
    }
    state.rulesets.set(REDIRECT_PHASE, updated);
    const action = found.state === "update" ? redirectAction(found.rule) : null;
    this.logged([redirect.source], state.ref.zone.name, found.state, "Cloudflare redirect rule",
      `${hosts.join(" and ")}: ${describeRedirect(redirect)}`, action ? describeRedirect(action) : undefined);
  }

  /** Deletes a redirect's stand-in site once Cloudflare answers for it: the rule and records are in, and the zone is active. */
  private async retireStandIn(state: ZoneState, redirect: Redirect): Promise<void> {
    const standIns = this.context.standIns;
    if (!standIns?.current[redirect.source] || state.ref.zone.status !== "active") return;
    const plan = this.planSite(this.entries.find((site) => site.domain === redirect.source)!);
    if (plan.problems.length || plan.changes.some((change) => change.action !== "note" && change.subject !== "Stand-in site")) return;
    await standIns.remove(redirect.source);
    delete standIns.current[redirect.source];
    this.logged([redirect.source], "", "delete", "Stand-in site", "The redirect is served by Cloudflare now");
  }

  /** While there is no Cloudflare connection, redirects are stand-in sites on this server. */
  private async enforceStandIns(plans: SitePlan[]): Promise<void> {
    const standIns = this.context.standIns;
    if (!standIns) return;
    for (const plan of plans) {
      const redirect = this.redirects.get(plan.domain)!;
      const current = standIns.current[plan.domain];
      try {
        if (!current) await standIns.create(redirect);
        else if (describeRedirect(current) !== describeRedirect(redirect)) await standIns.update(redirect);
        else continue;
        standIns.current[plan.domain] = { target: redirect.target, status: redirect.status, keepPath: redirect.keepPath, keepQuery: redirect.keepQuery };
        this.logged([plan.domain], "", current ? "update" : "create", "Stand-in site", describeRedirect(redirect), current ? describeRedirect(current) : undefined);
      } catch (error) {
        this.fail(plan.domain, error);
      }
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
          this.logged([domain], "", "create", "Mailcow domain", domain);
        }
        if (!state.dkim) {
          if (settings.dkimSource) await api.duplicateDkim(settings.dkimSource, domain);
          else await api.generateDkim(domain, settings.dkimSelector, settings.dkimBits);
          state.dkim = await api.dkim(domain);
          if (!state.dkim) throw new ProviderError("Mailcow", `did not return the DKIM key it made for ${domain}`);
          this.logged([domain], "", "create", "Mailcow DKIM key",
            settings.dkimSource ? `Shared with ${settings.dkimSource}` : `${settings.dkimBits}-bit, selector ${settings.dkimSelector}`);
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
      this.logged(missing, "", "update", "Mailcow sender list", `${mailbox} may send as ${missing.map((domain) => `@${domain}`).join(", ")}`);
      const after = await api.senderAcl(mailbox);
      this.acl.set(mailbox, after);
      const refused = missing.filter((domain) => !after || !aclAllows(after, domain));
      for (const domain of refused) this.fail(domain, new ProviderError("Mailcow", `did not let ${mailbox} send as @${domain}`));
    } catch (error) {
      for (const domain of ok) this.fail(domain, error);
    }
  }

  private async applyRecords(state: ZoneState, ops: RecordOp[], domain: string): Promise<void> {
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
      const change = this.recordChange(op);
      this.logged([domain], state.ref.zone.name, op.action, change.subject, change.detail, change.before);
    }
  }

  private logged(sites: string[], zone: string, action: LogEntry["action"], subject: string, detail: string, before?: string): void {
    this.log.push({ at: new Date().toISOString(), sites, zone, action, subject, detail, ...before !== undefined && { before } });
  }

  // -------------------------------------------------------------------------
  // What the run leaves behind
  // -------------------------------------------------------------------------

  /** The rule a redirect domain's deletion would delete, from what `load` read; null when there is none to delete. */
  redirectRuleOf(source: string): { zone: ZoneView; rulesetId: string; rule: CfRuleset["rules"][number] } | { problem: string } | null {
    const redirect = this.redirects.get(source);
    const resolved = this.resolve(source);
    if (!redirect || resolved.kind !== "zone") return null;
    const state = this.zones.get(resolved.ref.zone.id);
    if (!state?.records || state.error) return { problem: state?.error ?? `${resolved.ref.zone.name} could not be read` };
    const ruleset = state.rulesets.get(REDIRECT_PHASE);
    const found = redirectRuleState(ruleset ?? null, redirect, redirectHosts(source, resolved.ref.zone.name));
    if (found.state === "problem") return { problem: found.problem };
    if (found.state === "create" || !ruleset) return null;
    return { zone: this.zoneView(resolved.ref), rulesetId: ruleset.id, rule: found.rule };
  }

  async deleteRedirectRule(source: string, zoneId: string, rulesetId: string, ruleId: string): Promise<void> {
    const ref = this.zoneRefs.find((candidate) => candidate.zone.id === zoneId)!;
    await this.cloudflare.get(ref.connectionId)!.deleteRule(zoneId, REDIRECT_PHASE, rulesetId, ruleId);
    this.logged([source], ref.zone.name, "delete", "Cloudflare redirect rule", `${source}: the redirect domain was deleted`);
  }

  /** Whole-host redirect rules in every zone the connections reach, each zone read through its first connection. */
  async findRedirects(): Promise<{ redirects: FoundRedirect[]; notes: string[] }> {
    const zones = new Map<string, ZoneRef>();
    for (const ref of this.zoneRefs) if (!INACTIVE_ZONES.has(ref.zone.status) && !zones.has(ref.zone.id)) zones.set(ref.zone.id, ref);
    const read = await Promise.all([...zones.values()].map(async (ref): Promise<{ ref: ZoneRef; rules: CfRuleset["rules"] } | { ref: ZoneRef; error: string }> => {
      try {
        return { ref, rules: (await this.cloudflare.get(ref.connectionId)!.entrypoint(ref.zone.id, REDIRECT_PHASE))?.rules ?? [] };
      } catch (error) {
        return { ref, error: reason(error) };
      }
    }));
    const redirects = new Map<string, FoundRedirect>();
    const failed = new Map<string, string[]>();
    for (const entry of read) {
      if ("error" in entry) {
        failed.set(entry.error, [...failed.get(entry.error) ?? [], entry.ref.zone.name]);
        continue;
      }
      for (const rule of entry.rules) {
        const found = foundRedirect(rule, entry.ref.zone.name);
        if (found && !redirects.has(found.source)) redirects.set(found.source, found);
      }
    }
    return {
      redirects: [...redirects.values()].sort((a, b) => a.source.localeCompare(b.source)),
      notes: [...failed].map(([error, names]) => `${names.length === 1 ? names[0] : `${names.length} zones`} could not be read: ${error}`),
    };
  }

  /** The records an enforcing site has exactly as wanted, to recognise them once the site is gone. */
  managed(plans: SitePlan[]): Record<string, ManagedRecords> {
    const result: Record<string, ManagedRecords> = {};
    for (const plan of plans) {
      const diff = this.diffs.get(plan.domain);
      if (!this.context.policy.automatic || plan.redirect || !plan.zone || !diff || !diff.matched.length) continue;
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

  async deleteRecords(domain: string, entry: ManagedRecords, ids: string[]): Promise<void> {
    const api = this.cloudflare.get(entry.connectionId)!;
    for (const id of ids) {
      await api.deleteRecord(entry.zoneId, id);
      const record = entry.records.find((tracked) => tracked.id === id)!;
      this.logged([domain], entry.zoneName, "delete", `${record.type} ${record.name}`, describeRecord(record));
    }
  }
}

/** Whether a new site's certificate can be requested now, and if not, why. */
/** A record a site CloudPanel just created may write before review: an address at its own name or `www`. */
function pointsOwnName(domain: string, op: RecordOp): boolean {
  if (op.action === "create") return true;
  const own = op.record.name === domain || op.record.name === `www.${domain}`;
  const address = (type: string | undefined) => type === "A" || type === "AAAA" || type === "CNAME";
  return own && address(op.record.type) && (!op.current || address(op.current.type));
}

export function readiness(plan: SitePlan | undefined): { ready: boolean; reason: string; zone?: string; nameServers?: string[] } {
  if (!plan?.profileId) return { ready: false, reason: "No DNS profile is assigned to this site" };
  if (plan.mode !== "enforce") return { ready: false, reason: "DNS is set to Ask first" };
  if (plan.problems.length) return { ready: false, reason: plan.problems.join("; ") };
  if (!plan.zone) return { ready: false, reason: "Its Cloudflare zone is being created" };
  if (plan.zone.status !== "active") {
    const servers = plan.zone.nameServers.length ? `: ${plan.zone.nameServers.join(", ")}` : "";
    return {
      ready: false, reason: `Zone ${plan.zone.name} is ${plan.zone.status}; set its nameservers at the registrar${servers}`,
      zone: plan.zone.name, nameServers: plan.zone.nameServers,
    };
  }
  if (plan.changes.some((change) => change.action !== "note" && !change.waits)) return { ready: false, reason: "Some DNS changes have not been made yet" };
  if (!plan.certificateNames.includes(plan.domain)) return { ready: false, reason: "The profile manages no address for this site" };
  return { ready: true, reason: "DNS is in place" };
}
