/**
 * One pass over Cloudflare and Mailcow: find what every connection can reach,
 * read the zones the fleet's sites live in, work out each site's plan, and --
 * once DNS is Automatic -- carry it out.
 *
 * Planning is synchronous over what was read, so the same pass can plan,
 * write, and plan again for its report without reading everything twice.
 */
import { errorMessage } from "../../lib/errors";
import { getDomain } from "tldts";
import type { Addresses } from "./addresses";
import { grants, targetFor, uncertain, type TokenAccess } from "../../lib/cloudflare/access";
import { PERMISSIONS } from "../../lib/cloudflare/tokens";
import type { CfRuleset } from "../../lib/cloudflare/api";
import { type ApiFetch, ProviderError } from "../../lib/provider-http";
import { CloudflareDnsProvider } from "./cloudflare-provider";
import { aclAllows, MailcowApi, type MailcowDkim } from "./mailcow";
import type { AccountRef, Policy, Profile, Redirect, Secrets } from "./model";
import { PowerDnsProvider } from "./powerdns";
import {
  PROVIDER_LABELS, type DnsAccount, type DnsProvider, type DnsRecord, type DnsZone, type ProviderKind,
  type RecordOp, type RecordWrite,
} from "./provider";
import {
  describeRecord, diffRecords, normalizeRenderedForProvider, renderProfile, renderRedirect, wildcardSource,
  type Claim, type Diff, type Rendered, type SiteVars,
} from "./records";
import {
  describeRedirect, foundRedirect, PLACEHOLDER, REDIRECT_PHASE, redirectAction, redirectHosts, redirectRef, redirectRuleState, standInHosts, wantedRedirectRule,
  type FoundRedirect,
} from "./redirects";
import { ruleState, SSL_LABELS, wantedRules, wantedSettings, zoneWants, type ZoneWants } from "./zone";

const RECORD_COMMENT = "Managed by CloudPanel DNS";

export interface PanelSite {
  id: number;
  domain: string;
  type: string;
  /** Its site user; absent for a redirect domain. */
  user?: string;
  /** When CloudPanel created it, in milliseconds. */
  createdAt: number;
  /** Still on the self-signed certificate CloudPanel creates a site with. */
  selfSigned: boolean;
  cloudflareOnly: boolean;
  /** Set for a redirect domain, which is planned beside the sites but is not one. */
  redirect?: Redirect;
  /** Set for the panel hostname, planned beside the sites too. */
  panel?: true;
}

/** What a stand-in site on this server redirects to now. */
export type StandIn = Pick<Redirect, "target" | "status" | "keepPath" | "keepQuery"> & {
  /** The site exists but its vhost was never written, so it does not redirect yet. */
  incomplete?: boolean;
  /** The hosts the stand-in vhost serves; defaults to standInHosts(source) when absent. */
  hosts?: string[];
};

/** The CloudPanel sites that serve redirects while no edge redirect provider manages them. */
export interface StandIns {
  current: Record<string, StandIn>;
  create(redirect: Redirect, hosts?: string[]): Promise<void>;
  update(redirect: Redirect, hosts?: string[]): Promise<void>;
  remove(source: string): Promise<void>;
}

export interface ConnectionReport {
  id: string;
  label: string;
  provider?: ProviderKind;
  active: boolean;
  status: string;
  accounts: DnsAccount[];
  zones: number;
  /** Active or pending zone names this connection reaches, for picking a zone on the page. */
  zoneNames?: string[];
  error: string | null;
  /** What the token holds, read with the check; absent before its first one. */
  token?: TokenAccess;
  /** Permissions Cloudflare refused the token, by label. */
  refused?: string[];
}

interface ZoneRef {
  zone: DnsZone;
  connectionId: string;
  provider: ProviderKind;
}

interface ZoneView {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  account: string;
  connection: string;
  connectionId?: string;
  provider?: ProviderKind;
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
  /** The panel hostname. */
  panel?: true;
  /** The zone wildcard that covers this entry's own address records, when explicit ones are omitted. */
  wildcard?: string;
  /** Why a matching wildcard in the zone cannot cover this entry (RFC 4592). */
  wildcardBlocked?: string;
}

export interface ManagedRecords {
  zoneId: string;
  zoneName: string;
  connectionId: string;
  records: DnsRecord[];
}

export interface RunContext {
  policy: Policy;
  secrets: Secrets;
  sites: PanelSite[];
  addresses: Addresses;
  fetch?: ApiFetch;
  /** When each provider asked to be left alone until, carried between runs. */
  backoff: { cloudflare: number; mailcow: number; powerdns?: number };
  standIns?: StandIns;
  /** Whether CloudPanel serves an issued certificate for the panel hostname, so Cloudflare may proxy it. */
  panelProxied?: boolean;
  /** Each connection's token as the last check read it, for a run that does not read it again. */
  tokens?: Record<string, TokenAccess | undefined>;
}

export const PANEL_PROFILE_ID = "panel-hostname";

/**
 * What the panel hostname is held to: its addresses here, proxied only once
 * CloudPanel has its certificate, and the rule that lets the renewals through.
 */
export function panelProfile(proxied: boolean): Profile {
  const row = (type: "A" | "AAAA", content: string) => ({ type, name: "{domain}", content, proxied, ttl: 1, priority: null, apexOnly: false });
  return {
    id: PANEL_PROFILE_ID, name: "Panel hostname", records: [row("A", "{ipv4}"), row("AAAA", "{ipv6}")], mailcow: false,
    zone: { ssl: null, alwaysHttps: null, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: [] },
  };
}

/** The profiles a token is held to: the policy's, and the panel hostname's while one is set. */
export function tokenProfiles(policy: Pick<Policy, "profiles" | "panelHost">): Profile[] {
  return policy.panelHost ? [...policy.profiles, panelProfile(false)] : policy.profiles;
}

interface ZoneState {
  ref: ZoneRef;
  records: DnsRecord[] | null;
  settings: Map<string, string>;
  rulesets: Map<string, CfRuleset | null>;
  error: string | null;
}

function zoneMapKey(connectionId: string, zoneId: string): string {
  return `${connectionId}:${zoneId}`;
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
/** What a stand-in whose vhost was never written serves. */
const NOT_REDIRECTING = "A static site that does not redirect yet";
const MAILCOW_PLACEHOLDER = /\{mailcow\./;

function reason(error: unknown): string {
  return errorMessage(error);
}

interface SiblingPlan {
  zoneKey: string;
  records: RecordWrite[];
  wildcardClaims: Claim[];
}

type Siblings = Map<string, SiblingPlan>;

const ADDRESS_TYPES = new Set(["A", "AAAA"]);

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
  private readonly providers = new Map<string, DnsProvider>();
  private readonly connectionMeta: { id: string; label: string; provider: ProviderKind }[];
  private readonly mailcow: MailcowApi | null;
  private readonly cloudflareBackoff: { until: number };
  private readonly powerdnsBackoff: { until: number };
  private readonly mailcowBackoff: { until: number };
  private readonly held: Set<string>;
  /** CloudPanel's sites, then the redirect domains. */
  readonly entries: PanelSite[];
  private readonly redirects: Map<string, Redirect>;
  private readonly siteDomains: Set<string>;
  private readonly panelHost: string | null;

  constructor(private readonly context: RunContext) {
    this.redirects = new Map(context.policy.redirects.map((redirect) => [redirect.source, redirect]));
    this.siteDomains = new Set(context.sites.map((site) => site.domain));
    const host = context.policy.panelHost;
    // A site or redirect domain of the same name is that entry's, and the panel hostname waits.
    this.panelHost = host && !this.siteDomains.has(host) && !this.redirects.has(host) ? host : null;
    this.entries = [
      ...context.sites.filter((site) => !this.redirects.has(site.domain)),
      ...context.policy.redirects.map((redirect) => ({
        id: 0, domain: redirect.source, type: "redirect", createdAt: 0, selfSigned: false, cloudflareOnly: false, redirect,
      })),
      ...this.panelHost ? [{ id: 0, domain: this.panelHost, type: "panel", createdAt: 0, selfSigned: false, cloudflareOnly: false, panel: true as const }] : [],
    ];
    this.cloudflareBackoff = { until: context.backoff.cloudflare };
    this.powerdnsBackoff = { until: context.backoff.powerdns ?? 0 };
    this.mailcowBackoff = { until: context.backoff.mailcow };
    this.held = new Set(context.policy.held);
    const powerdnsConnections = context.policy.powerdns ?? [];
    this.connectionMeta = [
      ...context.policy.connections.map((connection) => ({ id: connection.id, label: connection.label, provider: "cloudflare" as const })),
      ...powerdnsConnections.map((connection) => ({ id: connection.id, label: connection.label, provider: "powerdns" as const })),
    ];
    for (const connection of context.policy.connections) {
      const token = context.secrets.cloudflare[connection.id];
      if (token) this.providers.set(connection.id, new CloudflareDnsProvider(token, context.fetch, this.cloudflareBackoff));
    }
    for (const connection of powerdnsConnections) {
      const apiKey = context.secrets.powerdns?.[connection.id];
      if (apiKey) this.providers.set(connection.id, new PowerDnsProvider(connection, apiKey, context.fetch, this.powerdnsBackoff));
    }
    const { url } = context.policy.mailcow;
    this.mailcow = url && context.secrets.mailcowKey
      ? new MailcowApi(url, context.secrets.mailcowKey, context.fetch, this.mailcowBackoff)
      : null;
  }

  /** The token each connection was read with, so its report is not kept for a token saved since. */
  get tokens(): Record<string, string> {
    return { ...this.context.secrets.cloudflare };
  }

  get panelProxied(): boolean {
    return this.context.panelProxied === true;
  }

  backoff(): { cloudflare: number; mailcow: number; powerdns: number } {
    return { cloudflare: this.cloudflareBackoff.until, mailcow: this.mailcowBackoff.until, powerdns: this.powerdnsBackoff.until };
  }

  /** The provider currently responsible for `domain`, after `discover()` has run. */
  resolvedProvider(domain: string): DnsProvider | null {
    const resolved = this.resolve(domain);
    if (resolved.kind === "zone") return this.providers.get(resolved.ref.connectionId) ?? null;
    if (resolved.kind === "missing" && resolved.createIn) return this.providers.get(resolved.createIn.connectionId) ?? null;
    return null;
  }

  // -------------------------------------------------------------------------
  // What every connection reaches
  // -------------------------------------------------------------------------

  /** `readTokens` also reads each Cloudflare token's own permissions: on a check of every site and when a connection is saved. */
  async discover(readTokens = false): Promise<void> {
    const reports = await Promise.all(this.connectionMeta.map(async (connection): Promise<ConnectionReport & { refs?: ZoneRef[] }> => {
      const report: ConnectionReport = {
        id: connection.id, label: connection.label, provider: connection.provider,
        active: false, status: "missing", accounts: [], zones: 0, error: null,
      };
      const provider = this.providers.get(connection.id);
      if (!provider) {
        return { ...report, error: connection.provider === "powerdns" ? "No API key is saved for this connection" : "No token is saved for this connection" };
      }
      const checked = await provider.discover(readTokens);
      if (!checked.active) return { ...report, status: checked.status, error: checked.error };
      const zoneNames = [...new Set(checked.zones.filter((zone) => !INACTIVE_ZONES.has(zone.status)).map((zone) => zone.name))].sort();
      return {
        ...report,
        active: true,
        status: checked.status,
        accounts: checked.accounts,
        zones: checked.zones.length,
        zoneNames,
        ...(checked.token ? { token: checked.token } : {}),
        refs: checked.zones.map((zone) => ({ zone, connectionId: connection.id, provider: connection.provider })),
      };
    }));
    // In the configured order, not the order the reads finished: the first
    // connection reaching a zone is the one that writes it.
    for (const { refs, ...report } of reports) {
      if (refs) this.zoneRefs.push(...refs);
      this.connections.push(report);
    }
  }

  /** Each connection's report, with the permissions Cloudflare refused it during this run. */
  reports(): ConnectionReport[] {
    return this.connections.map((report) => {
      const refused = this.providers.get(report.id)?.refusedPermissions?.() ?? [];
      return refused.length ? { ...report, refused } : report;
    });
  }

  private connectionLabel(id: string): string {
    return this.connectionMeta.find((connection) => connection.id === id)?.label ?? id;
  }

  private connectionProvider(id: string): ProviderKind {
    return this.connectionMeta.find((connection) => connection.id === id)?.provider ?? "cloudflare";
  }

  /** The longest zone, across every connection, that the domain is in or under. */
  private resolve(domain: string): Resolution {
    const matches = this.zoneRefs.filter(({ zone }) => !INACTIVE_ZONES.has(zone.status) && (domain === zone.name || domain.endsWith(`.${zone.name}`)));
    if (!matches.length) {
      const failed = this.connections.filter((connection) => !connection.active);
      if (!this.connections.length) return { kind: "unreachable", reason: "Add a DNS connection first" };
      // A zone only a failed connection reaches would look missing, and be created again elsewhere.
      if (failed.length) {
        const names = [...new Set(failed.map((connection) => PROVIDER_LABELS[connection.provider ?? "cloudflare"]))].join(" or ");
        return { kind: "unreachable", reason: `${names} could not be read: ${failed.map((c) => c.error).join("; ")}` };
      }
      const name = getDomain(domain, { allowPrivateDomains: false }) ?? domain;
      const accounts = this.connections.flatMap((connection) => connection.accounts.map((account) => ({
        connectionId: connection.id,
        accountId: account.id,
        key: connection.provider === "powerdns" ? `${connection.id}/${account.id}` : account.id,
      })));
      const unique = new Set(accounts.map((account) => account.key));
      return {
        kind: "missing",
        name,
        createIn: this.context.policy.createIn ?? (unique.size === 1 ? { connectionId: accounts[0]!.connectionId, accountId: accounts[0]!.accountId } : null),
        accounts: unique.size,
      };
    }
    const longest = Math.max(...matches.map(({ zone }) => zone.name.length));
    const candidates = matches.filter(({ zone }) => zone.name.length === longest);
    const name = candidates[0]!.zone.name;
    const choice = this.context.policy.zoneChoices[name];
    const chosen = choice && candidates.find((ref) => ref.connectionId === choice.connectionId && ref.zone.id === choice.zoneId);
    if (chosen) return { kind: "zone", ref: chosen };
    const sameZone = choice ? candidates.filter((ref) => ref.provider === "cloudflare" && ref.zone.id === choice.zoneId) : [];
    const same = sameZone.find((ref) => this.writesRecords(ref) !== false) ?? sameZone[0];
    if (same) return { kind: "zone", ref: same };
    // The chosen zone is out of reach, and what is left is a zone the operator did not pick.
    if (choice) return { kind: "choose", candidates, name, lost: true };
    const ids = new Set(candidates.map((ref) => ref.provider === "cloudflare" ? `cf:${ref.zone.id}` : `${ref.connectionId}:${ref.zone.id}`));
    // The first connection that can write the zone's records is used until another is chosen; one that only reads them never is.
    if (ids.size === 1) return { kind: "zone", ref: candidates.find((ref) => this.writesRecords(ref) !== false) ?? candidates[0]! };
    return { kind: "choose", candidates, name };
  }

  /** Whether a connection's token holds DNS: Edit on the zone, from its own policies; null when not known. */
  private writesRecords(ref: ZoneRef): boolean | null {
    if (ref.provider !== "cloudflare") return true;
    const token = this.connections.find((connection) => connection.id === ref.connectionId)?.token ?? this.context.tokens?.[ref.connectionId];
    if (!token?.readable) return null;
    const permission = PERMISSIONS.dns;
    const held = grants(token.grants, permission, targetFor(permission, { id: ref.zone.id, accountId: ref.zone.account.id }, token));
    return uncertain(token.grants, permission, held ? "yes" : "no") ? null : held;
  }

  /** No connection means redirects are served from this server with no DNS writes. */
  private onServer(): boolean {
    return this.connectionMeta.length === 0;
  }

  plannedDomains(): string[] {
    return this.entries.filter((entry) => entry.redirect || this.profileOf(entry.domain)).map((entry) => entry.domain);
  }

  private profileOf(domain: string): Profile | null {
    if (domain === this.panelHost) return panelProfile(this.context.panelProxied === true);
    const redirect = this.redirects.get(domain);
    const id = redirect ? redirect.profileId : this.context.policy.assignments[domain];
    return this.context.policy.profiles.find((profile) => profile.id === id) ?? null;
  }

  /** Every assigned site's profile in each zone that supports zone settings or rules. */
  private zoneProfiles(withHeld = true): Map<string, Profile[]> {
    if (withHeld && this.profilesByZone) return this.profilesByZone;
    const byZone = new Map<string, Profile[]>();
    for (const site of this.entries) {
      const profile = this.profileOf(site.domain);
      if (!profile || (!withHeld && this.held.has(site.domain))) continue;
      if (site.redirect && this.onServer()) continue;
      const resolved = this.resolve(site.domain);
      if (resolved.kind !== "zone") continue;
      const provider = this.providers.get(resolved.ref.connectionId);
      if (!provider || (!provider.capabilities.zoneSettings && !provider.capabilities.zoneRules)) continue;
      const key = zoneMapKey(resolved.ref.connectionId, resolved.ref.zone.id);
      const list = byZone.get(key) ?? [];
      list.push(profile);
      byZone.set(key, list);
    }
    if (withHeld) this.profilesByZone = byZone;
    return byZone;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private async loadZone(ref: ZoneRef, wants: ZoneWants, redirects = false): Promise<void> {
    const provider = this.providers.get(ref.connectionId)!;
    const key = zoneMapKey(ref.connectionId, ref.zone.id);
    const state: ZoneState = this.zones.get(key) ?? { ref, records: null, settings: new Map(), rulesets: new Map(), error: null };
    this.zones.set(key, state);
    try {
      const edge = provider.edge;
      const settings = provider.capabilities.zoneSettings && edge
        ? wantedSettings(wants).map((wanted) => wanted.setting).filter((setting) => !state.settings.has(setting))
        : [];
      const phases = edge
        ? [...new Set([
          ...provider.capabilities.zoneRules ? wantedRules(wants).map((rule) => rule.phase) : [],
          ...redirects && provider.capabilities.edgeRedirects ? [REDIRECT_PHASE] : [],
        ])].filter((phase) => !state.rulesets.has(phase))
        : [];
      const [records, values, rulesets] = await Promise.all([
        state.records ?? provider.listRecords(ref.zone),
        Promise.all(settings.map((setting) => edge!.setting(ref.zone.id, setting))),
        Promise.all(phases.map((phase) => edge!.entrypoint(ref.zone.id, phase))),
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
        const key = zoneMapKey(resolved.ref.connectionId, resolved.ref.zone.id);
        refs.set(key, resolved.ref);
        if (redirect) redirectZones.add(key);
      }
      if (profile?.mailcow) mailDomains.push(domain);
    }
    await Promise.all([
      ...[...refs.entries()].map(([key, ref]) => this.loadZone(ref, zoneWants(byZone.get(key) ?? []).wants, redirectZones.has(key))),
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
      connectionId: ref.connectionId, provider: ref.provider,
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

  /**
   * Collects sibling records and wildcard claims for `zoneKey` from `siblings`,
   * excluding `exclude`, so a subdomain planned beside sibling entries sees
   * planned wildcards and any sibling record that would block a wildcard.
   */
  private siblingContext(siblings: Siblings | undefined, zoneKey: string, exclude: string): { zoneRecords: RecordWrite[]; zoneClaims: Claim[] } | undefined {
    if (!siblings) return undefined;
    const zoneRecords: RecordWrite[] = [];
    const zoneClaims: Claim[] = [];
    for (const [domain, sibling] of siblings) {
      if (domain === exclude || sibling.zoneKey !== zoneKey) continue;
      zoneRecords.push(...sibling.records);
      zoneClaims.push(...sibling.wildcardClaims);
    }
    return { zoneRecords, zoneClaims };
  }

  /** What a problem-free entry contributes to sibling planning in its zone. */
  private recordSibling(
    out: Siblings | undefined,
    site: PanelSite,
    zoneKey: string,
    plan: SitePlan,
    rendered: Rendered,
    diff: Diff,
    published: readonly DnsRecord[],
    allWanted: boolean,
  ): void {
    if (!out || plan.problems.length || (site.redirect && plan.held)) return;
    const waitsAt = (name: string) => Boolean(plan.held) && !site.redirect
      && diff.ops.some((op) => op.record.name === name && !pointsOwnName(site.domain, op, published));
    const records: RecordWrite[] = [];
    for (const record of diff.wanted) {
      if (waitsAt(record.name)) continue;
      if (record.name.startsWith("*.") || allWanted || site.redirect || !ADDRESS_TYPES.has(record.type)) {
        records.push(record);
      }
    }
    for (const dkim of rendered.waitingDkim) {
      records.push({ type: "TXT", name: dkim, content: "", proxied: false, ttl: 1, priority: null });
    }
    const wildcardClaims = rendered.claims.filter((claim) => claim.name.startsWith("*.") && !waitsAt(claim.name));
    out.set(site.domain, { zoneKey, records, wildcardClaims });
  }

  /** The plan for one site, or one redirect domain, from what has been read. */
  planSite(site: PanelSite, siblings?: Siblings, out?: Siblings, allWanted = false): SitePlan {
    const plan = this.planEntry(site, siblings, out, allWanted);
    // A redirect domain held after a connection arrived waits for its review as a whole.
    if (site.redirect && plan.held) plan.changes = plan.changes.map((change) => change.action === "note" ? change : { ...change, waits: true });
    return plan;
  }

  private planEntry(site: PanelSite, siblings?: Siblings, out?: Siblings, allWanted = false): SitePlan {
    const { redirect } = site;
    const profile = this.profileOf(site.domain);
    const plan: SitePlan = {
      domain: site.domain, profileId: profile?.id ?? null, mode: this.context.policy.automatic ? "enforce" : "report", zone: null,
      changes: [], problems: [], zoneChoices: [], certificateNames: [], ...redirect && { redirect: true as const },
      ...site.panel && { panel: true as const },
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
        label: ref.provider === "powerdns"
          ? `${this.connectionLabel(ref.connectionId)} · PowerDNS (${ref.zone.account.id})`
          : `${this.connectionLabel(ref.connectionId)} · ${ref.zone.account.name || ref.zone.account.id} (${ref.zone.status})`,
      }));
      return plan;
    }
    if (profile && profile.records.some((row) => MAILCOW_PLACEHOLDER.test(row.name + row.content)) && !profile.mailcow) {
      plan.problems.push("Rows use {mailcow.…} placeholders, but the profile does not set up Mailcow");
      return plan;
    }
    plan.problems.push(...this.failures.get(site.domain) ?? []);
    if (profile?.mailcow) this.mailChanges(site.domain, profile, plan);
    const render = (zoneName: string, provider: DnsProvider): Rendered => {
      const raw = redirect
        ? renderRedirect(
          profile,
          redirectHosts(redirect.source, zoneName),
          this.vars(site.domain, zoneName, profile),
          provider.capabilities.edgeRedirects ? PLACEHOLDER : null,
        )
        : renderProfile(profile!, this.vars(site.domain, zoneName, profile));
      return normalizeRenderedForProvider(raw, provider);
    };

    if (resolved.kind === "missing") {
      const { createIn } = resolved;
      const account = createIn && this.connections.find((c) => c.id === createIn.connectionId)?.accounts.find((a) => a.id === createIn.accountId);
      const createProvider = createIn ? this.providers.get(createIn.connectionId) : undefined;
      if (!createIn) {
        const onlyCloudflare = this.connections.every((connection) => (connection.provider ?? "cloudflare") === "cloudflare");
        plan.problems.push(resolved.accounts
          ? `${resolved.name} is not in ${onlyCloudflare ? "Cloudflare" : "any connected DNS provider"}; choose the account for new zones under Settings`
          : `${resolved.name} is not in ${onlyCloudflare ? "Cloudflare" : "any connected DNS provider"}, and no connection reaches an account to create it in`);
      } else if (!account || !createProvider || !createProvider.capabilities.createZone) {
        plan.problems.push("The account for new zones is not reachable; choose another under Settings");
      } else {
        const providerLabel = PROVIDER_LABELS[createProvider.kind];
        plan.changes.push({ action: "create", subject: `${providerLabel} zone`, detail: `${resolved.name} in ${account.name || account.id}; then set its nameservers at the registrar` });
        if (redirect) {
          if (createProvider.capabilities.edgeRedirects) {
            const hosts = redirectHosts(redirect.source, resolved.name);
            plan.changes.push({ action: "create", subject: "Cloudflare redirect rule", detail: `${hosts.join(" and ")}: ${describeRedirect(redirect)}` });
          } else {
            this.planStandInChanges(redirect, plan, resolved.name);
          }
        }
        const zoneKey = `missing:${resolved.name}`;
        const rendered = render(resolved.name, createProvider);
        const ctx = redirect ? undefined : this.siblingContext(siblings, zoneKey, site.domain);
        // A new zone is empty, so everything the profile wants (other than what a sibling's wildcard covers) is a record to create.
        const diff = diffRecords(rendered, [], { allowWildcard: !redirect, ...ctx });
        plan.problems.push(...diff.problems);
        this.noteWildcard(plan, diff, site.domain);
        for (const op of diff.ops) plan.changes.push(this.recordChange(op, diff, createProvider.capabilities.proxy));
        if (redirect && createProvider.capabilities.edgeRedirects) this.standInChange(redirect.source, resolved.name, false, plan);
        this.recordSibling(out, site, zoneKey, plan, rendered, diff, [], allWanted);
      }
      return plan;
    }

    const key = zoneMapKey(resolved.ref.connectionId, resolved.ref.zone.id);
    const state = this.zones.get(key);
    const provider = this.providers.get(resolved.ref.connectionId)!;
    plan.zone = this.zoneView(resolved.ref);
    if (!state?.records) {
      plan.problems.push(state?.error ?? "This zone has not been read yet");
      return plan;
    }
    if (state.error) plan.problems.push(state.error);

    if (provider.capabilities.zoneSettings || provider.capabilities.zoneRules) {
      // A profile that disagrees with another in its zone is stopped. What the plan shows is what this site's own profile asks.
      const own = profile ? [profile] : [];
      plan.problems.push(...zoneWants([...own, ...this.zoneProfiles().get(key) ?? []]).problems);
      this.zoneChanges(state, zoneWants(own).wants, plan);
    }
    if (redirect) {
      if (provider.capabilities.edgeRedirects) this.redirectRuleChange(state, redirect, plan);
      else this.planStandInChanges(redirect, plan, resolved.ref.zone.name);
    }

    const zoneKey = `zone:${key}`;
    const rendered = render(resolved.ref.zone.name, provider);
    const ctx = redirect ? undefined : this.siblingContext(siblings, zoneKey, site.domain);
    const diff = diffRecords(rendered, state.records, { allowWildcard: !redirect, ...ctx });
    this.diffs.set(site.domain, diff);
    plan.problems.push(...diff.problems);
    this.noteWildcard(plan, diff, site.domain);
    for (const name of rendered.waitingDkim) {
      plan.changes.push({ action: "create", subject: `TXT ${name}`, detail: "Mailcow's DKIM key, once Mailcow holds it" });
    }
    for (const op of diff.ops) {
      const change = this.recordChange(op, diff, provider.capabilities.proxy);
      plan.changes.push(plan.held && !redirect && !pointsOwnName(site.domain, op, state.records) ? { ...change, waits: true } : change);
    }
    this.recordSibling(out, site, zoneKey, plan, rendered, diff, state.records, allWanted);
    if (redirect) {
      if (provider.capabilities.edgeRedirects) this.standInChange(redirect.source, resolved.ref.zone.name, resolved.ref.zone.status === "active", plan);
      return plan;
    }
    if (site.panel) return plan;
    const addresses = diff.wanted.filter((record) => ["A", "AAAA", "CNAME"].includes(record.type));
    const www = `www.${site.domain}`;
    const effective = [...state.records, ...diff.wanted, ...(ctx?.zoneRecords ?? [])];
    const wildcardHeld = Boolean(plan.held)
      && diff.ops.some((op) => op.record.name === `*.${site.domain}` && !pointsOwnName(site.domain, op, state.records!));
    const wwwByOwnWildcard = !wildcardHeld
      && addresses.some((record) => record.name === `*.${site.domain}`)
      && wildcardSource(www, resolved.ref.zone.name, effective)?.wildcard === `*.${site.domain}`;
    plan.certificateNames = [
      ...(addresses.some((record) => record.name === site.domain) || diff.covered[site.domain] ? [site.domain] : []),
      ...(addresses.some((record) => record.name === www) || diff.covered[www] || wwwByOwnWildcard ? [www] : []),
    ];
    return plan;
  }

  private noteWildcard(plan: SitePlan, diff: Diff, domain: string): void {
    if (diff.covered[domain]) plan.wildcard = diff.covered[domain];
    else if (diff.blockedWildcard[domain]) {
      const blocked = diff.blockedWildcard[domain]!;
      plan.wildcardBlocked = `${blocked.wildcard} does not match ${domain} while ${blocked.by} exists, so explicit records are needed`;
    }
  }

  private standInHostsFor(source: string, zoneName?: string): string[] {
    return zoneName ? redirectHosts(source, zoneName) : standInHosts(source);
  }

  private sameHosts(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((host, index) => host === right[index]);
  }

  private planStandInChanges(redirect: Redirect, plan: SitePlan, zoneName?: string): void {
    const current = this.context.standIns?.current[redirect.source];
    const hosts = this.standInHostsFor(redirect.source, zoneName);
    if (!current) {
      plan.changes.push({
        action: "create", subject: "Stand-in site",
        detail: `A static site on this server for ${hosts.join(" and ")}: ${describeRedirect(redirect)}`,
      });
    } else {
      const currentHosts = current.hosts ?? standInHosts(redirect.source);
      const hostsChanged = !this.sameHosts(currentHosts, hosts);
      if (current.incomplete || describeRedirect(current) !== describeRedirect(redirect) || hostsChanged) {
        plan.changes.push({
          action: "update", subject: "Stand-in site",
          detail: hostsChanged ? `${hosts.join(" and ")}: ${describeRedirect(redirect)}` : describeRedirect(redirect),
          before: current.incomplete ? NOT_REDIRECTING : hostsChanged ? `${currentHosts.join(" and ")}: ${describeRedirect(current)}` : describeRedirect(current),
        });
      }
    }
  }

  /** A redirect served from this server, while DNS has no provider connection. */
  private planStandIn(redirect: Redirect, profile: Profile | null, plan: SitePlan): SitePlan {
    this.planStandInChanges(redirect, plan);
    if (profile) plan.changes.push({ action: "note", subject: "Profile", detail: "Its records apply once a DNS connection reaches this domain" });
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

  private recordChange(op: RecordOp, diff?: Diff, proxy = true): Change {
    const subject = `${op.record.type} ${op.record.name}`;
    const opts = { proxy };
    if (op.action === "update") return { action: "update", subject, detail: describeRecord(op.record, opts), before: describeRecord(op.current!, opts) };
    const covered = op.action === "delete" ? diff?.covered[op.record.name] : undefined;
    return { action: op.action, subject, detail: covered ? `${describeRecord(op.record, opts)} · covered by ${covered}` : describeRecord(op.record, opts) };
  }

  private markClashes(plans: SitePlan[]): void {
    const byZone = new Map<string, SitePlan[]>();
    for (const plan of plans) {
      if (plan.zone && this.diffs.has(plan.domain)) {
        const key = zoneMapKey(plan.zone.connectionId ?? "", plan.zone.id);
        byZone.set(key, [...byZone.get(key) ?? [], plan]);
      }
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
  }

  /**
   * Plans every site and redirect domain, then marks those in one zone whose
   * profiles want different records at one name. With `live` true (or Ask
   * first), plans strictly against published records in Cloudflare. Otherwise
   * runs a two-pass sibling context so reviews and pre-enforce plans see both
   * planned wildcards and any non-covered sibling records that block them.
   */
  planAll(scope?: string[], live = false): SitePlan[] {
    if (live || !this.context.policy.automatic) {
      const plans = this.entries.map((site) => this.planSite(site));
      this.markClashes(plans);
      return plans;
    }
    const allowed = scope ? new Set(scope) : null;
    const pass0Out: Siblings = new Map();
    const pass0 = this.entries.map((site) => this.planSite(site, undefined, pass0Out, false));
    this.markClashes(pass0);
    const eligible = new Set(pass0
      .filter((plan) => !plan.problems.length && !(plan.redirect && plan.held) && (!allowed || allowed.has(plan.domain)))
      .map((plan) => plan.domain));
    const pass1Siblings: Siblings = new Map([...pass0Out].filter(([domain]) => eligible.has(domain)));

    const pass1Out: Siblings = new Map();
    const pass1 = this.entries.map((site) => this.planSite(site, pass1Siblings, pass1Out, true));
    this.markClashes(pass1);
    const pass2Eligible = new Set(pass1
      .filter((plan) => eligible.has(plan.domain) && !plan.problems.length)
      .map((plan) => plan.domain));
    const pass2Siblings: Siblings = new Map([...pass1Out].filter(([domain]) => pass2Eligible.has(domain)));

    const plans = this.entries.map((site) => this.planSite(site, pass2Siblings));
    this.markClashes(plans);
    return plans;
  }

  private clash(a: string, b: string): string | null {
    const left = this.diffs.get(a)!;
    const right = this.diffs.get(b)!;
    const atName = (diff: Diff, name: string) => diff.wanted.filter((record) => record.name === name).map((record) => describeRecord(record)).sort().join("\n");
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

  private writeOrder(plan: SitePlan): number {
    const diff = this.diffs.get(plan.domain);
    if (!diff) return 3;
    if (diff.wanted.some((record) => record.name.startsWith("*."))) return 0;
    if (plan.wildcard) return 3;
    const selfNonAddress = diff.wanted.some((record) => !ADDRESS_TYPES.has(record.type)
      && (record.name === plan.domain || record.name.endsWith(`.${plan.domain}`)));
    if (plan.redirect || selfNonAddress || (diff.wanted.length > 0 && !plan.wildcardBlocked)) return 1;
    if (diff.wanted.length > 0) return 2;
    return 3;
  }

  /**
   * Makes the given sites and redirect domains match once DNS is Automatic.
   * Those with problems are left alone, and so is a redirect domain held for
   * its review.
   */
  async enforce(domains: string[]): Promise<void> {
    const scope = new Set(domains);
    const ready = () => this.planAll(domains)
      .filter((plan) => plan.mode === "enforce" && !plan.problems.length && scope.has(plan.domain) && !(plan.redirect && plan.held));

    if (this.onServer()) {
      await this.enforceStandIns(ready().filter((plan) => plan.redirect));
      return;
    }
    await this.createZones(ready());
    const targets = ready().filter((plan) => plan.zone);
    if (!targets.length) return;
    const byZone = this.zoneProfiles();
    const reviewed = this.zoneProfiles(false);

    const planZoneKey = (plan: SitePlan) => zoneMapKey(plan.zone!.connectionId ?? "", plan.zone!.id);

    await Promise.all([...new Set(targets.map(planZoneKey))].map((key) => {
      const state = this.zones.get(key)!;
      const provider = this.providers.get(state.ref.connectionId)!;
      if (!provider.capabilities.zoneSettings && !provider.capabilities.zoneRules) return Promise.resolve();
      const zoneDomains = targets.filter((plan) => planZoneKey(plan) === key).map((plan) => plan.domain);
      return this.enforceZone(state, byZone.get(key) ?? [], reviewed.get(key) ?? [], zoneDomains);
    }));
    await this.enforceMail(targets.filter((plan) => this.profileOf(plan.domain)?.mailcow).map((plan) => plan.domain));

    const after = ready().filter((plan) => plan.zone);
    await Promise.all([...new Set(after.map(planZoneKey))].map(async (key) => {
      const state = this.zones.get(key)!;
      const provider = this.providers.get(state.ref.connectionId)!;
      // One zone's writes go in order: wildcard writers first, then redirects and explicit/non-address writers (deepest first),
      // then wildcard-blocked explicit sites, then wildcard-covered sites that delete redundant records.
      const ordered = after.filter((candidate) => planZoneKey(candidate) === key)
        .sort((a, b) => (this.writeOrder(a) - this.writeOrder(b)) || (b.domain.length - a.domain.length));
      for (const plan of ordered) {
        try {
          // Re-planned against live zone records only so subdomain sites hand off only when a wildcard is already published and unobstructed.
          const entry = this.entries.find((site) => site.domain === plan.domain)!;
          const fresh = this.planSite(entry);
          if (fresh.problems.length) continue;
          if (entry.redirect) {
            if (provider.capabilities.edgeRedirects) {
              // The redirect before its placeholder, so the placeholder never answers on its own.
              await this.enforceRedirectRule(state, entry.redirect);
            } else {
              // Without edge redirects, keep the local stand-in site ready before pointing DNS here.
              await this.enforceStandIns([fresh]);
              if (this.failures.get(plan.domain)?.length) continue;
            }
          }
          const diff = this.diffs.get(plan.domain)!;
          const ops = fresh.held ? diff.ops.filter((op) => pointsOwnName(plan.domain, op, state.records!)) : diff.ops;
          await this.applyRecords(state, ops, plan.domain, diff);
          if (entry.redirect && provider.capabilities.edgeRedirects) await this.retireStandIn(state, entry.redirect);
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
        const provider = this.providers.get(createIn.connectionId)!;
        if (!provider.createZone || !provider.capabilities.createZone) {
          throw new Error("The selected connection does not create zones");
        }
        const zone = await provider.createZone(name, createIn.accountId);
        const providerLabel = PROVIDER_LABELS[provider.kind];
        this.logged(domains, name, "create", `${providerLabel} zone`,
          `In ${accountName(createIn)}${zone.nameServers.length ? `; nameservers ${zone.nameServers.join(", ")}` : ""}`);
        const ref: ZoneRef = { zone, connectionId: createIn.connectionId, provider: provider.kind };
        const key = zoneMapKey(createIn.connectionId, zone.id);
        this.zoneRefs.push(ref);
        this.profilesByZone = null;
        this.zones.set(key, { ref, records: null, settings: new Map(), rulesets: new Map(), error: null });
        const profiles = domains.map((domain) => this.profileOf(domain)).filter((profile) => profile !== null);
        await this.loadZone(ref, zoneWants(profiles).wants, domains.some((domain) => this.redirects.has(domain)));
      } catch (error) {
        for (const domain of domains) this.fail(domain, error);
      }
    }));
  }

  /** `reviewed` leaves out held sites' profiles: their rules are written, their zone settings wait. */
  private async enforceZone(state: ZoneState, profiles: Profile[], reviewed: Profile[], domains: string[]): Promise<void> {
    const provider = this.providers.get(state.ref.connectionId)!;
    const edge = provider.edge;
    if (!edge) return;
    const zoneId = state.ref.zone.id;
    const { wants, problems } = zoneWants(profiles);
    if (problems.length) return;
    const zone = state.ref.zone.name;
    try {
      if (provider.capabilities.zoneSettings) {
        for (const wanted of wantedSettings(zoneWants(reviewed).wants)) {
          const current = state.settings.get(wanted.setting);
          if (current === wanted.value) continue;
          await edge.setSetting(zoneId, wanted.setting, wanted.value);
          state.settings.set(wanted.setting, wanted.value);
          const before = current === undefined ? undefined : wanted.setting === "ssl" ? SSL_LABELS[current as keyof typeof SSL_LABELS] ?? current : current;
          this.logged([], zone, "update", "Zone setting, whole zone", wanted.label, before);
        }
      }
      if (provider.capabilities.zoneRules) {
        // Rules before records, so a proxied record never exists without the rule its certificate needs.
        for (const spec of wantedRules(wants)) {
          const ruleset = state.rulesets.get(spec.phase) ?? null;
          const found = ruleState(ruleset, spec.rule);
          if (found.state === "present") continue;
          let updated: CfRuleset;
          if (!ruleset) updated = await edge.createEntrypoint(zoneId, spec.phase, [spec.rule]);
          else if (found.state === "update") updated = await edge.updateRule(zoneId, spec.phase, ruleset.id, found.ruleId, spec.rule);
          else updated = await edge.addRule(zoneId, spec.phase, ruleset.id, spec.rule);
          state.rulesets.set(spec.phase, updated);
          this.logged([], zone, found.state === "update" ? "update" : "create", "Cloudflare rule, whole zone", spec.label);
        }
      }
    } catch (error) {
      for (const domain of domains) this.fail(domain, error);
    }
  }

  private async enforceRedirectRule(state: ZoneState, redirect: Redirect): Promise<void> {
    const edge = this.providers.get(state.ref.connectionId)?.edge;
    if (!edge) return;
    const zoneId = state.ref.zone.id;
    const hosts = redirectHosts(redirect.source, state.ref.zone.name);
    const ruleset = state.rulesets.get(REDIRECT_PHASE) ?? null;
    const found = redirectRuleState(ruleset, redirect, hosts);
    if (found.state === "present" || found.state === "problem") return;
    const wanted = wantedRedirectRule(redirect, hosts);
    let updated: CfRuleset;
    if (!ruleset) updated = await edge.createEntrypoint(zoneId, REDIRECT_PHASE, [wanted]);
    else if (found.state === "create") updated = await edge.addRule(zoneId, REDIRECT_PHASE, ruleset.id, wanted);
    else {
      try {
        updated = await edge.updateRule(zoneId, REDIRECT_PHASE, ruleset.id, found.rule.id, wanted);
      } catch (error) {
        // Should Cloudflare keep a rule's own ref, the rule is still found by its hosts on every check.
        if (!(error instanceof ProviderError) || error.status !== 400 || !found.rule.ref || found.rule.ref === wanted.ref) throw error;
        updated = await edge.updateRule(zoneId, REDIRECT_PHASE, ruleset.id, found.rule.id, { ...wanted, ref: found.rule.ref });
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

  /** While there is no edge redirect provider, redirects are stand-in sites on this server. */
  private async enforceStandIns(plans: SitePlan[]): Promise<void> {
    const standIns = this.context.standIns;
    if (!standIns) return;
    for (const plan of plans) {
      const redirect = this.redirects.get(plan.domain)!;
      const current = standIns.current[plan.domain];
      const hosts = this.standInHostsFor(redirect.source, plan.zone?.name);
      const currentHosts = current ? current.hosts ?? standInHosts(redirect.source) : [];
      const hostsChanged = Boolean(current) && !this.sameHosts(currentHosts, hosts);
      try {
        if (!current) await standIns.create(redirect, hosts);
        else if (current.incomplete || describeRedirect(current) !== describeRedirect(redirect) || hostsChanged) await standIns.update(redirect, hosts);
        else continue;
        standIns.current[plan.domain] = { target: redirect.target, status: redirect.status, keepPath: redirect.keepPath, keepQuery: redirect.keepQuery, hosts };
        const before = !current ? undefined : current.incomplete ? NOT_REDIRECTING : hostsChanged ? `${currentHosts.join(" and ")}: ${describeRedirect(current)}` : describeRedirect(current);
        const detail = hostsChanged ? `${hosts.join(" and ")}: ${describeRedirect(redirect)}` : describeRedirect(redirect);
        this.logged([plan.domain], "", current ? "update" : "create", "Stand-in site", detail, before);
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

  private async applyRecords(state: ZoneState, ops: RecordOp[], domain: string, diff?: Diff): Promise<void> {
    if (!ops.length) return;
    const provider = this.providers.get(state.ref.connectionId)!;
    state.records = await provider.applyRecords(state.ref.zone, ops, state.records!, {
      comment: RECORD_COMMENT,
      onApplied: (op, records) => {
        state.records = records;
        const change = this.recordChange(op, diff, provider.capabilities.proxy);
        this.logged([domain], state.ref.zone.name, op.action, change.subject, change.detail, change.before);
      },
    });
  }

  private logged(sites: string[], zone: string, action: LogEntry["action"], subject: string, detail: string, before?: string): void {
    this.log.push({ at: new Date().toISOString(), sites, zone, action, subject, detail, ...before !== undefined && { before } });
  }

  // -------------------------------------------------------------------------
  // What the run leaves behind
  // -------------------------------------------------------------------------

  /**
   * The rule a redirect domain's deletion would delete, from what `load` read;
   * null when the zone's provider has no edge redirects or Cloudflare has no
   * rule. A zone a failed connection or an unmade choice hides could still hold one.
   */
  redirectRuleOf(source: string): { zone: ZoneView; rulesetId: string; rule: CfRuleset["rules"][number] } | { problem: string } | null {
    const redirect = this.redirects.get(source);
    if (!redirect) return null;
    const resolved = this.resolve(source);
    if (resolved.kind === "unreachable") return { problem: resolved.reason };
    if (resolved.kind === "choose") return { problem: `${resolved.name} is reachable through more than one connection; choose which one manages it` };
    if (resolved.kind !== "zone") return null;
    const provider = this.providers.get(resolved.ref.connectionId);
    if (!provider?.capabilities.edgeRedirects || !provider.edge) return null;
    const state = this.zones.get(zoneMapKey(resolved.ref.connectionId, resolved.ref.zone.id));
    if (!state?.records || state.error) return { problem: state?.error ?? `${resolved.ref.zone.name} could not be read` };
    const ruleset = state.rulesets.get(REDIRECT_PHASE);
    const found = redirectRuleState(ruleset ?? null, redirect, redirectHosts(source, resolved.ref.zone.name));
    if (found.state === "problem") return { problem: found.problem };
    if (found.state === "create" || !ruleset) return null;
    return { zone: this.zoneView(resolved.ref), rulesetId: ruleset.id, rule: found.rule };
  }

  async deleteRedirectRule(source: string, zoneId: string, rulesetId: string, ruleId: string, connectionId?: string): Promise<void> {
    const ref = this.zoneRefs.find((candidate) => candidate.zone.id === zoneId && (!connectionId || candidate.connectionId === connectionId))!;
    await this.providers.get(ref.connectionId)!.edge!.deleteRule(zoneId, REDIRECT_PHASE, rulesetId, ruleId);
    this.logged([source], ref.zone.name, "delete", "Cloudflare redirect rule", `${source}: the redirect domain was deleted`);
  }

  /** Whole-host redirect rules in every Cloudflare zone the connections reach, each zone read through its first connection. */
  async findRedirects(): Promise<{ redirects: FoundRedirect[]; notes: string[] }> {
    const zones = new Map<string, ZoneRef>();
    for (const ref of this.zoneRefs) {
      const provider = this.providers.get(ref.connectionId);
      if (!provider?.capabilities.edgeRedirects || !provider.edge) continue;
      if (!INACTIVE_ZONES.has(ref.zone.status) && !zones.has(ref.zone.id)) zones.set(ref.zone.id, ref);
    }
    const read = await Promise.all([...zones.values()].map(async (ref): Promise<{ ref: ZoneRef; rules: CfRuleset["rules"] } | { ref: ZoneRef; error: string }> => {
      try {
        return { ref, rules: (await this.providers.get(ref.connectionId)!.edge!.entrypoint(ref.zone.id, REDIRECT_PHASE))?.rules ?? [] };
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
      const state = this.zones.get(zoneMapKey(plan.zone.connectionId ?? "", plan.zone.id))!;
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
  stillWanted(record: Pick<DnsRecord, "name">): boolean {
    return [...this.diffs.values()].some((diff) => diff.names.includes(record.name));
  }

  /** Whether a zone some current site is in could not be read, so what its sites want is unknown. */
  unread(zoneId: string, connectionId?: string): boolean {
    const state = connectionId
      ? this.zones.get(zoneMapKey(connectionId, zoneId))
      : [...this.zones.values()].find((candidate) => candidate.ref.zone.id === zoneId);
    return state !== undefined && (state.records === null || state.error !== null);
  }

  /**
   * Whether every connection, the one that wrote a site's records among them,
   * listed its zones and none listed that zone. Cloudflare answers a deleted
   * zone's reads with "Authentication error", so the listing tells it apart.
   */
  zoneGone(entry: Pick<ManagedRecords, "connectionId" | "zoneId">): boolean {
    return this.connections.some((connection) => connection.id === entry.connectionId)
      && this.connections.every((connection) => connection.active)
      && !this.zoneRefs.some((ref) => ref.zone.id === entry.zoneId && (ref.provider === "cloudflare" || ref.connectionId === entry.connectionId));
  }

  logZoneGone(domain: string, entry: ManagedRecords): void {
    const providerLabel = PROVIDER_LABELS[this.connectionProvider(entry.connectionId)];
    this.logged([domain], entry.zoneName, "delete", `${providerLabel} zone`,
      `Deleted outside DNS, with the ${entry.records.length === 1 ? "record" : `${entry.records.length} records`} DNS wrote for ${domain}`);
  }

  /** The zone's records, read now, through the connection that tracked them. */
  async readZone(connectionId: string, zoneId: string, zoneName = ""): Promise<DnsRecord[]> {
    const provider = this.providers.get(connectionId);
    if (!provider) throw new Error("The connection these records were tracked through has been removed");
    const ref = this.zoneRefs.find((candidate) => candidate.connectionId === connectionId && candidate.zone.id === zoneId);
    const zone: DnsZone = ref?.zone ?? { id: zoneId, name: zoneName, status: "active", nameServers: [], account: { id: "", name: "" } };
    return provider.listRecords(zone);
  }

  async deleteRecords(domain: string, entry: ManagedRecords, ids: string[], currentRecords?: DnsRecord[]): Promise<void> {
    const provider = this.providers.get(entry.connectionId)!;
    const ref = this.zoneRefs.find((candidate) => candidate.connectionId === entry.connectionId && candidate.zone.id === entry.zoneId);
    const zone: DnsZone = ref?.zone ?? { id: entry.zoneId, name: entry.zoneName, status: "active", nameServers: [], account: { id: "", name: "" } };
    const published = currentRecords ?? await provider.listRecords(zone);
    const ops: RecordOp[] = ids.map((id) => {
      const tracked = entry.records.find((record) => record.id === id)!;
      return { action: "delete", record: tracked, current: tracked };
    });
    await provider.applyRecords(zone, ops, published, {
      onApplied: (op) => {
        this.logged([domain], entry.zoneName, "delete", `${op.record.type} ${op.record.name}`, describeRecord(op.record, { proxy: provider.capabilities.proxy }));
      },
    });
  }
}

/**
 * A record a site CloudPanel just created may write before review: an address
 * at its own name or `www`, or a new record at a name that has no published
 * records yet (such as a missing `*.{domain}` wildcard).
 */
function pointsOwnName(domain: string, op: RecordOp, published: readonly DnsRecord[]): boolean {
  const own = op.record.name === domain || op.record.name === `www.${domain}`;
  if (op.action === "create") return own || !published.some((record) => record.name === op.record.name);
  const address = (type: string | undefined) => type === "A" || type === "AAAA" || type === "CNAME";
  return own && address(op.record.type) && (!op.current || address(op.current.type));
}

/** Whether a new site's certificate can be requested now, and if not, why. */
export function readiness(plan: SitePlan | undefined): { ready: boolean; reason: string; zone?: string; nameServers?: string[] } {
  if (!plan?.profileId) return { ready: false, reason: "No DNS profile is assigned to this site" };
  if (plan.mode !== "enforce") return { ready: false, reason: "DNS is set to Ask first" };
  if (plan.problems.length) return { ready: false, reason: plan.problems.join("; ") };
  if (!plan.zone) return { ready: false, reason: "Its DNS zone is being created" };
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
