/**
 * One pass over Cloudflare and local CloudPanel stand-in sites for Redirects:
 * discover connected Cloudflare zones, load rules and web records for redirect
 * hosts, plan every redirect synchronously, and apply changes when Automatic.
 *
 * Non-web DNS records (MX, TXT, SRV, CAA, and any other hostname) are never
 * claimed or deleted. Only web records (`A`, `AAAA`, `CNAME`) at the redirect's
 * own hosts are replaced with proxied `AAAA 100::` placeholders when Cloudflare
 * serves the redirect.
 */
import { isIP } from "node:net";
import { grants, targetFor, uncertain, type TokenAccess } from "../../lib/cloudflare/access";
import { CloudflareApi, type CfRecord, type CfRuleset, type CfZone, type RecordWrite } from "../../lib/cloudflare/api";
import {
  readTokenAccess, type CloudflareConnection, type CloudflareConnectionReport,
} from "../../lib/cloudflare/store";
import { PERMISSIONS } from "../../lib/cloudflare/tokens";
import { errorMessage } from "../../lib/errors";
import { type ApiFetch, ProviderError, redact } from "../../lib/provider-http";
import type { Policy, Redirect } from "./model";
import {
  describeRedirect, foundRedirect, isOurRedirectRef, PLACEHOLDER, REDIRECT_PHASE, redirectAction, redirectHosts,
  redirectRuleState, standInHosts, wantedRedirectRule, type FoundRedirect,
} from "./rules";
import type { StandIns } from "./stand-in";

const RECORD_COMMENT = "Managed by CloudPanel Redirects";
const INACTIVE_ZONES = new Set(["moved", "deleted", "deactivated"]);
const WEB_TYPES = new Set(["A", "AAAA", "CNAME"]);
/** What a stand-in whose vhost was never written serves. */
const NOT_REDIRECTING = "A static site that does not redirect yet";

export interface ZoneView {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  account: string;
  connection: string;
  connectionId: string;
}

export interface Change {
  action: "create" | "update" | "delete" | "note";
  subject: string;
  detail: string;
  before?: string;
  /** Waits for an administrator's review (provider transition hold). */
  waits?: true;
}

export interface LogEntry {
  at: string;
  sites: string[];
  zone: string;
  action: "create" | "update" | "delete";
  subject: string;
  detail: string;
  before?: string;
}

export interface RedirectPlan {
  domain: string;
  mode: "report" | "enforce";
  zone: ZoneView | null;
  changes: Change[];
  problems: string[];
  zoneChoices: { zone: string; connectionId: string; zoneId: string; label: string }[];
  held?: true;
}

export interface TrackedRedirectRule {
  connectionId: string;
  zoneId: string;
  zoneName: string;
}

export interface RedirectsRunContext {
  policy: Policy;
  connections: CloudflareConnection[];
  tokens: Record<string, string>;
  /** Real CloudPanel sites (stand-ins excluded). */
  siteDomains: Set<string>;
  fetch?: ApiFetch;
  backoff: number;
  standIns?: StandIns;
  /** Cached token access from the last check, for runs that do not re-read policies. */
  storedTokens?: Record<string, TokenAccess | undefined>;
}

interface ZoneRef {
  zone: CfZone;
  connectionId: string;
}

interface ZoneState {
  ref: ZoneRef;
  records: CfRecord[] | null;
  ruleset: CfRuleset | null;
  rulesetLoaded: boolean;
  error: string | null;
}

interface RecordOp {
  action: "create" | "update" | "delete";
  record: RecordWrite;
  current?: CfRecord;
}

interface PlaceholderDiff {
  ops: RecordOp[];
  problems: string[];
}

type Resolution =
  | { kind: "zone"; ref: ZoneRef }
  | { kind: "local" }
  | { kind: "choose"; candidates: ZoneRef[]; name: string; lost?: boolean }
  | { kind: "unreachable"; reason: string };

function zoneMapKey(connectionId: string, zoneId: string): string {
  return `${connectionId}:${zoneId}`;
}

function canonicalIpv6(value: string): string {
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

function describeWebRecord(record: Pick<RecordWrite, "type" | "content" | "proxied" | "ttl">): string {
  const parts = [record.content, record.proxied ? "proxied" : "DNS only"];
  if (!record.proxied && record.ttl !== 1) parts.push(`TTL ${record.ttl}`);
  return parts.join(" · ");
}

function sameHosts(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((host, index) => host === right[index]);
}

/**
 * Computes web placeholder ops for `hosts` in `zoneName` without touching any
 * non-web records (MX, TXT, SRV, CAA, NS, SOA) or any other hostname.
 */
function diffPlaceholders(hosts: string[], zoneName: string, published: CfRecord[]): PlaceholderDiff {
  const problems: string[] = [];
  const hostSet = new Set(hosts);
  const delegations = published.filter((current) => current.type === "NS" && current.name !== zoneName);
  for (const name of new Set(delegations.map((current) => current.name))) {
    if (hosts.some((host) => host === name || host.endsWith(`.${name}`))) {
      problems.push(`${name} is delegated to other nameservers by NS records`);
    }
  }

  const pool = published.filter((current) => hostSet.has(current.name) && WEB_TYPES.has(current.type));
  const used = new Set<CfRecord>();
  const updates: RecordOp[] = [];
  const creates: RecordOp[] = [];

  for (const host of hosts) {
    const wanted: RecordWrite = { type: "AAAA", name: host, content: PLACEHOLDER, proxied: true, ttl: 1, priority: null };
    const candidates = pool.filter((current) => !used.has(current) && current.name === host && current.type === "AAAA");
    const exact = candidates.find((current) => canonicalIpv6(current.content) === PLACEHOLDER && current.proxied);
    if (exact) {
      used.add(exact);
      continue;
    }
    const sameContent = candidates.find((current) => canonicalIpv6(current.content) === PLACEHOLDER);
    const reusable = sameContent ?? candidates[0];
    if (reusable) {
      used.add(reusable);
      updates.push({ action: "update", record: wanted, current: reusable });
    } else {
      creates.push({ action: "create", record: wanted });
    }
  }

  const deletes: RecordOp[] = pool
    .filter((current) => !used.has(current))
    .map((current) => ({ action: "delete", record: current, current }));
  // Update existing AAAA first, delete conflicting A/AAAA/CNAME before creating AAAA placeholders.
  return { ops: [...updates, ...deletes, ...creates], problems };
}

export class RedirectsRun {
  readonly connections: CloudflareConnectionReport[] = [];
  readonly log: LogEntry[] = [];
  private readonly apis = new Map<string, CloudflareApi>();
  private readonly zoneRefs: ZoneRef[] = [];
  private readonly zones = new Map<string, ZoneState>();
  private readonly failures = new Map<string, string[]>();
  private readonly diffs = new Map<string, PlaceholderDiff>();
  private readonly cloudflareBackoff: { until: number };
  private readonly held: Set<string>;
  private readonly redirects: Map<string, Redirect>;

  constructor(private readonly context: RedirectsRunContext) {
    this.redirects = new Map(context.policy.redirects.map((redirect) => [redirect.source, redirect]));
    this.held = new Set(context.policy.held);
    this.cloudflareBackoff = { until: context.backoff };
    for (const connection of context.connections) {
      const token = context.tokens[connection.id];
      if (token) this.apis.set(connection.id, new CloudflareApi(token, context.fetch, this.cloudflareBackoff));
    }
  }

  get tokens(): Record<string, string> {
    return { ...this.context.tokens };
  }

  backoff(): number {
    return this.cloudflareBackoff.until;
  }

  async discover(readTokens = false): Promise<void> {
    const results = await Promise.all(this.context.connections.map(async (connection): Promise<CloudflareConnectionReport & { refs?: ZoneRef[] }> => {
      const report: CloudflareConnectionReport = {
        id: connection.id, label: connection.label, active: false, status: "missing", accounts: [], zones: 0, error: null,
      };
      const api = this.apis.get(connection.id);
      const token = this.context.tokens[connection.id];
      if (!api || !token) return { ...report, error: "No token is saved for this connection" };
      try {
        const verified = await api.verify();
        report.status = verified.status;
        if (!verified.active) return { ...report, error: `Cloudflare reports this token as ${verified.status}` };
        const [zones, accounts] = await Promise.all([api.zones(), api.accounts()]);
        const known = new Map(accounts.map((account) => [account.id, account]));
        for (const zone of zones) if (!known.has(zone.account.id)) known.set(zone.account.id, zone.account);
        const tokenAccess = readTokens
          ? await readTokenAccess(api, verified, {
              zones: zones.map((zone) => ({ id: zone.id, name: zone.name, accountId: zone.account.id })),
              accounts: [...known.values()],
            })
          : undefined;
        const zoneNames = [...new Set(zones.filter((zone) => !INACTIVE_ZONES.has(zone.status)).map((zone) => zone.name))].sort();
        return {
          ...report,
          active: true,
          accounts: [...known.values()],
          zones: zones.length,
          zoneNames,
          ...(tokenAccess ? { token: tokenAccess } : {}),
          refs: zones.map((zone) => ({ zone, connectionId: connection.id })),
        };
      } catch (error) {
        return { ...report, status: "error", error: redact(errorMessage(error), [token]) };
      }
    }));
    for (const { refs, ...report } of results) {
      if (refs) this.zoneRefs.push(...refs);
      this.connections.push(report);
    }
  }

  reports(): CloudflareConnectionReport[] {
    return this.connections.map((report) => {
      const refused = [...(this.apis.get(report.id)?.refused ?? [])];
      return refused.length ? { ...report, refused } : report;
    });
  }

  private connectionLabel(id: string): string {
    return this.context.connections.find((connection) => connection.id === id)?.label ?? id;
  }

  private writesRecords(ref: ZoneRef): boolean | null {
    const token = this.connections.find((connection) => connection.id === ref.connectionId)?.token ?? this.context.storedTokens?.[ref.connectionId];
    if (!token?.readable) return null;
    const permission = PERMISSIONS.dns;
    const held = grants(token.grants, permission, targetFor(permission, { id: ref.zone.id, accountId: ref.zone.account.id }, token));
    return uncertain(token.grants, permission, held ? "yes" : "no") ? null : held;
  }

  /** Resolves a redirect domain to a Cloudflare zone, a local stand-in site, a disambiguation choice, or a read error. */
  private resolve(redirect: Redirect): Resolution {
    if (redirect.mode === "local" || !this.context.connections.length) return { kind: "local" };
    const source = redirect.source;
    const matches = this.zoneRefs.filter(({ zone }) => !INACTIVE_ZONES.has(zone.status) && (source === zone.name || source.endsWith(`.${zone.name}`)));
    if (!matches.length) {
      const failed = this.connections.filter((connection) => !connection.active);
      if (failed.length) {
        return { kind: "unreachable", reason: `Cloudflare could not be read: ${failed.map((c) => c.error).join("; ")}` };
      }
      return { kind: "local" };
    }
    const longest = Math.max(...matches.map(({ zone }) => zone.name.length));
    const candidates = matches.filter(({ zone }) => zone.name.length === longest);
    const name = candidates[0]!.zone.name;
    const choice = this.context.policy.zoneChoices[name];
    const chosen = choice && candidates.find((ref) => ref.connectionId === choice.connectionId && ref.zone.id === choice.zoneId);
    if (chosen) return { kind: "zone", ref: chosen };
    const sameZone = choice ? candidates.filter((ref) => ref.zone.id === choice.zoneId) : [];
    const same = sameZone.find((ref) => this.writesRecords(ref) !== false) ?? sameZone[0];
    if (same) return { kind: "zone", ref: same };
    if (choice) return { kind: "choose", candidates, name, lost: true };
    const ids = new Set(candidates.map((ref) => ref.zone.id));
    if (ids.size === 1) return { kind: "zone", ref: candidates.find((ref) => this.writesRecords(ref) !== false) ?? candidates[0]! };
    return { kind: "choose", candidates, name };
  }

  private async loadZone(ref: ZoneRef): Promise<void> {
    const api = this.apis.get(ref.connectionId)!;
    const key = zoneMapKey(ref.connectionId, ref.zone.id);
    const state: ZoneState = this.zones.get(key) ?? { ref, records: null, ruleset: null, rulesetLoaded: false, error: null };
    this.zones.set(key, state);
    try {
      const [records, ruleset] = await Promise.all([
        state.records ?? api.records(ref.zone.id),
        state.rulesetLoaded ? Promise.resolve(state.ruleset) : api.entrypoint(ref.zone.id, REDIRECT_PHASE),
      ]);
      state.records = records;
      state.ruleset = ruleset;
      state.rulesetLoaded = true;
    } catch (error) {
      state.error = errorMessage(error);
    }
  }

  async load(domains: string[]): Promise<void> {
    const refs = new Map<string, ZoneRef>();
    for (const domain of domains) {
      const redirect = this.redirects.get(domain);
      if (!redirect) continue;
      const resolved = this.resolve(redirect);
      if (resolved.kind === "zone") refs.set(zoneMapKey(resolved.ref.connectionId, resolved.ref.zone.id), resolved.ref);
    }
    await Promise.all([...refs.values()].map((ref) => this.loadZone(ref)));
  }

  private zoneView(ref: ZoneRef): ZoneView {
    const { zone } = ref;
    return {
      id: zone.id,
      name: zone.name,
      status: zone.status,
      nameServers: zone.nameServers,
      account: zone.account.name || zone.account.id,
      connection: this.connectionLabel(ref.connectionId),
      connectionId: ref.connectionId,
    };
  }

  private standInHostsFor(redirect: Redirect): string[] {
    return redirect.hosts?.length ? redirect.hosts : standInHosts(redirect.source);
  }

  private planStandInChanges(redirect: Redirect, plan: RedirectPlan): void {
    const current = this.context.standIns?.current[redirect.source];
    const hosts = this.standInHostsFor(redirect);
    if (!current) {
      plan.changes.push({
        action: "create",
        subject: "Stand-in site",
        detail: `A static site on this server for ${hosts.join(" and ")}: ${describeRedirect(redirect)}`,
      });
    } else {
      const currentHosts = current.hosts ?? standInHosts(redirect.source);
      const hostsChanged = !sameHosts(currentHosts, hosts);
      if (current.incomplete || describeRedirect(current) !== describeRedirect(redirect) || hostsChanged) {
        plan.changes.push({
          action: "update",
          subject: "Stand-in site",
          detail: hostsChanged ? `${hosts.join(" and ")}: ${describeRedirect(redirect)}` : describeRedirect(redirect),
          before: current.incomplete
            ? NOT_REDIRECTING
            : hostsChanged
              ? `${currentHosts.join(" and ")}: ${describeRedirect(current)}`
              : describeRedirect(current),
        });
      }
    }
  }

  private planRedirectEntry(redirect: Redirect): RedirectPlan {
    const plan: RedirectPlan = {
      domain: redirect.source,
      mode: this.context.policy.automatic ? "enforce" : "report",
      zone: null,
      changes: [],
      problems: [],
      zoneChoices: [],
    };
    this.diffs.delete(redirect.source);
    if (this.held.has(redirect.source)) plan.held = true;
    if (this.context.siteDomains.has(redirect.source)) {
      plan.problems.push(`CloudPanel has a site ${redirect.source}; delete the site or this redirect`);
      return plan;
    }
    plan.problems.push(...this.failures.get(redirect.source) ?? []);

    const resolved = this.resolve(redirect);
    if (resolved.kind === "local") {
      this.planStandInChanges(redirect, plan);
      return plan;
    }
    if (resolved.kind === "unreachable") {
      plan.problems.push(resolved.reason);
      return plan;
    }
    if (resolved.kind === "choose") {
      plan.problems.push(resolved.lost
        ? `The zone chosen for ${resolved.name} cannot be reached; check its connection, or choose again`
        : `${resolved.name} is reachable through more than one connection; choose which one manages it`);
      plan.zoneChoices = resolved.candidates.map((ref) => ({
        zone: resolved.name,
        connectionId: ref.connectionId,
        zoneId: ref.zone.id,
        label: `${this.connectionLabel(ref.connectionId)} · ${ref.zone.account.name || ref.zone.account.id} (${ref.zone.status})`,
      }));
      return plan;
    }

    const key = zoneMapKey(resolved.ref.connectionId, resolved.ref.zone.id);
    const state = this.zones.get(key);
    plan.zone = this.zoneView(resolved.ref);
    if (!state?.records) {
      plan.problems.push(state?.error ?? "This zone has not been read yet");
      return plan;
    }
    if (state.error) plan.problems.push(state.error);

    const hosts = redirectHosts(redirect.source, resolved.ref.zone.name);
    if (state.rulesetLoaded) {
      const found = redirectRuleState(state.ruleset, redirect, hosts);
      const detail = `${hosts.join(" and ")}: ${describeRedirect(redirect)}`;
      if (found.state === "problem") plan.problems.push(found.problem);
      else if (found.state === "create") plan.changes.push({ action: "create", subject: "Cloudflare redirect rule", detail });
      else if (found.state === "update") {
        const action = redirectAction(found.rule);
        const before = [
          action ? describeRedirect(action) : found.rule.expression,
          / and not starts_with\(http\.request\.uri\.path, "\/\.well-known\/acme-challenge\/"\)\s*$/.test(found.rule.expression) && "except Let's Encrypt checks",
          !found.rule.enabled && "disabled",
          !isOurRedirectRef(found.rule.ref, redirect.source) && "another tool's rule, taken over in place",
        ].filter(Boolean).join(" · ");
        plan.changes.push({ action: "update", subject: "Cloudflare redirect rule", detail, before });
      }
    }

    const diff = diffPlaceholders(hosts, resolved.ref.zone.name, state.records);
    this.diffs.set(redirect.source, diff);
    plan.problems.push(...diff.problems);
    for (const op of diff.ops) {
      const subject = `${op.record.type} ${op.record.name}`;
      if (op.action === "update") {
        plan.changes.push({
          action: "update",
          subject,
          detail: describeWebRecord(op.record),
          before: describeWebRecord(op.current!),
        });
      } else {
        plan.changes.push({ action: op.action, subject, detail: describeWebRecord(op.record) });
      }
    }

    if (this.context.standIns?.current[redirect.source]) {
      plan.changes.push({
        action: "delete",
        subject: "Stand-in site",
        detail: resolved.ref.zone.status === "active"
          ? "Deleted once the redirect is in Cloudflare"
          : `Deleted once the redirect is in Cloudflare and ${resolved.ref.zone.name} is active`,
      });
    }
    return plan;
  }

  planRedirect(redirect: Redirect): RedirectPlan {
    const plan = this.planRedirectEntry(redirect);
    if (plan.held) {
      plan.changes = plan.changes.map((change) => change.action === "note" ? change : { ...change, waits: true });
    }
    return plan;
  }

  planAll(scope?: string[]): RedirectPlan[] {
    const allowed = scope ? new Set(scope) : null;
    const plans: RedirectPlan[] = [];
    for (const redirect of this.context.policy.redirects) {
      if (allowed && !allowed.has(redirect.source)) continue;
      plans.push(this.planRedirect(redirect));
    }
    return plans;
  }

  /** Releases held redirects whose clean plan shows nothing left to change. */
  releaseHeld(): string[] {
    return [...this.held].filter((source) => {
      const redirect = this.redirects.get(source);
      if (!redirect) return false;
      const plan = this.planRedirect(redirect);
      if (plan.problems.length || plan.changes.some((change) => change.action !== "note")) return false;
      this.held.delete(source);
      return true;
    });
  }

  /** Holds `sources` in memory so `enforce` leaves them alone until reviewed. */
  hold(sources: string[]): void {
    for (const source of sources) this.held.add(source);
  }

  private fail(domain: string, error: unknown): void {
    this.failures.set(domain, [...this.failures.get(domain) ?? [], errorMessage(error)]);
  }

  private logged(sites: string[], zone: string, action: LogEntry["action"], subject: string, detail: string, before?: string): void {
    this.log.push({ at: new Date().toISOString(), sites, zone, action, subject, detail, ...before !== undefined && { before } });
  }

  async enforce(domains: string[]): Promise<void> {
    const scope = new Set(domains);
    const targets = this.planAll(domains)
      .filter((plan) => plan.mode === "enforce" && !plan.problems.length && !plan.held && scope.has(plan.domain));
    for (const plan of targets) {
      const redirect = this.redirects.get(plan.domain)!;
      if (!plan.zone) {
        await this.enforceStandIn(redirect);
        continue;
      }
      const state = this.zones.get(zoneMapKey(plan.zone.connectionId, plan.zone.id));
      if (!state) continue;
      try {
        const fresh = this.planRedirect(redirect);
        if (fresh.problems.length || fresh.held) continue;
        // Write the Single Redirect rule first so the placeholder record never answers on its own.
        await this.enforceRedirectRule(state, redirect);
        const diff = this.diffs.get(redirect.source);
        if (diff?.ops.length) await this.applyRecords(state, diff.ops, redirect.source);
        await this.retireStandIn(state, redirect);
      } catch (error) {
        this.fail(redirect.source, error);
      }
    }
  }

  private async enforceRedirectRule(state: ZoneState, redirect: Redirect): Promise<void> {
    const api = this.apis.get(state.ref.connectionId)!;
    const zoneId = state.ref.zone.id;
    const hosts = redirectHosts(redirect.source, state.ref.zone.name);
    const ruleset = state.ruleset;
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
    state.ruleset = updated;
    state.rulesetLoaded = true;
    const action = found.state === "update" ? redirectAction(found.rule) : null;
    this.logged(
      [redirect.source],
      state.ref.zone.name,
      found.state,
      "Cloudflare redirect rule",
      `${hosts.join(" and ")}: ${describeRedirect(redirect)}`,
      action ? describeRedirect(action) : undefined,
    );
  }

  private async applyRecords(state: ZoneState, ops: RecordOp[], source: string): Promise<void> {
    const api = this.apis.get(state.ref.connectionId)!;
    let records = [...(state.records ?? [])];
    for (const op of ops) {
      if (op.action === "create") {
        const created = await api.createRecord(state.ref.zone.id, op.record, RECORD_COMMENT);
        records.push(created);
        this.logged([source], state.ref.zone.name, "create", `${op.record.type} ${op.record.name}`, describeWebRecord(op.record));
      } else if (op.action === "update") {
        const updated = await api.updateRecord(state.ref.zone.id, op.current!.id, op.record);
        records = records.map((entry) => entry.id === updated.id ? updated : entry);
        this.logged(
          [source],
          state.ref.zone.name,
          "update",
          `${op.record.type} ${op.record.name}`,
          describeWebRecord(op.record),
          describeWebRecord(op.current!),
        );
      } else {
        await api.deleteRecord(state.ref.zone.id, op.current!.id);
        records = records.filter((entry) => entry.id !== op.current!.id);
        this.logged([source], state.ref.zone.name, "delete", `${op.record.type} ${op.record.name}`, describeWebRecord(op.record));
      }
      state.records = records;
    }
  }

  private async retireStandIn(state: ZoneState, redirect: Redirect): Promise<void> {
    const standIns = this.context.standIns;
    if (!standIns?.current[redirect.source] || state.ref.zone.status !== "active") return;
    const plan = this.planRedirect(redirect);
    if (plan.problems.length || plan.changes.some((change) => change.action !== "note" && change.subject !== "Stand-in site")) return;
    await standIns.remove(redirect.source);
    delete standIns.current[redirect.source];
    this.logged([redirect.source], "", "delete", "Stand-in site", "The redirect is served by Cloudflare now");
  }

  private async enforceStandIn(redirect: Redirect): Promise<void> {
    const standIns = this.context.standIns;
    if (!standIns) return;
    const current = standIns.current[redirect.source];
    const hosts = this.standInHostsFor(redirect);
    const currentHosts = current ? current.hosts ?? standInHosts(redirect.source) : [];
    const hostsChanged = Boolean(current) && !sameHosts(currentHosts, hosts);
    try {
      if (!current) await standIns.create(redirect, hosts);
      else if (current.incomplete || describeRedirect(current) !== describeRedirect(redirect) || hostsChanged) await standIns.update(redirect, hosts);
      else return;
      standIns.current[redirect.source] = {
        target: redirect.target,
        status: redirect.status,
        keepPath: redirect.keepPath,
        keepQuery: redirect.keepQuery,
        hosts,
      };
      const before = !current
        ? undefined
        : current.incomplete
          ? NOT_REDIRECTING
          : hostsChanged
            ? `${currentHosts.join(" and ")}: ${describeRedirect(current)}`
            : describeRedirect(current);
      const detail = hostsChanged ? `${hosts.join(" and ")}: ${describeRedirect(redirect)}` : describeRedirect(redirect);
      this.logged([redirect.source], "", current ? "update" : "create", "Stand-in site", detail, before);
    } catch (error) {
      this.fail(redirect.source, error);
    }
  }

  // -------------------------------------------------------------------------
  // Leftover Cloudflare rule cleanup & rule discovery
  // -------------------------------------------------------------------------

  /** Active Cloudflare zones that could hold a Single Redirect rule for `source`, deduplicated by physical zone ID. */
  private cloudflareRedirectZones(source: string, tracked?: TrackedRedirectRule): ZoneRef[] {
    const matching = this.zoneRefs.filter((ref) =>
      !INACTIVE_ZONES.has(ref.zone.status) && (source === ref.zone.name || source.endsWith(`.${ref.zone.name}`)));
    if (!matching.length) return [];
    const longest = Math.max(...matching.map((ref) => ref.zone.name.length));
    const candidates = matching.filter((ref) => ref.zone.name.length === longest || (tracked && ref.zone.id === tracked.zoneId));
    const byZoneId = new Map<string, ZoneRef[]>();
    for (const ref of candidates) {
      byZoneId.set(ref.zone.id, [...byZoneId.get(ref.zone.id) ?? [], ref]);
    }
    return [...byZoneId.values()].map((group) =>
      (tracked ? group.find((ref) => ref.connectionId === tracked.connectionId) : undefined)
      ?? group.find((ref) => this.writesRecords(ref) !== false)
      ?? group[0]!);
  }

  /** Reads every Cloudflare zone needed to check whether deleting or replacing `source` must also remove a Single Redirect rule. */
  async loadRedirectDeletion(source: string, tracked?: TrackedRedirectRule): Promise<void> {
    const redirect = this.redirects.get(source);
    const refs = new Map<string, ZoneRef>();
    if (redirect) {
      const resolved = this.resolve(redirect);
      if (resolved.kind === "zone") refs.set(zoneMapKey(resolved.ref.connectionId, resolved.ref.zone.id), resolved.ref);
    }
    for (const ref of this.cloudflareRedirectZones(source, tracked)) {
      refs.set(zoneMapKey(ref.connectionId, ref.zone.id), ref);
    }
    await Promise.all([...refs.values()].map((ref) => this.loadZone(ref)));
  }

  /**
   * The Cloudflare Single Redirect rule deleting or replacing `source` would remove;
   * null when Cloudflare has no matching rule. Inspects reachable Cloudflare zones
   * and any tracked destination even when `mode === "local"` or a stand-in serves it.
   */
  redirectRuleOf(
    source: string,
    tracked?: TrackedRedirectRule,
  ): { zone: ZoneView; rulesetId: string; rule: CfRuleset["rules"][number] } | { problem: string } | null {
    const redirect = this.redirects.get(source);
    if (!redirect) return null;
    const inspect = (ref: ZoneRef): { zone: ZoneView; rulesetId: string; rule: CfRuleset["rules"][number] } | { problem: string } | null => {
      const state = this.zones.get(zoneMapKey(ref.connectionId, ref.zone.id));
      if (!state?.rulesetLoaded || state.error) return { problem: state?.error ?? `${ref.zone.name} could not be read` };
      const found = redirectRuleState(state.ruleset, redirect, redirectHosts(source, ref.zone.name));
      if (found.state === "problem") return { problem: found.problem };
      if (found.state === "create" || !state.ruleset) return null;
      return { zone: this.zoneView(ref), rulesetId: state.ruleset.id, rule: found.rule };
    };

    const resolved = this.resolve(redirect);
    if (resolved.kind === "unreachable") return { problem: resolved.reason };
    if (resolved.kind === "choose") {
      return { problem: `${resolved.name} is reachable through more than one connection; choose which one manages it` };
    }
    if (resolved.kind === "zone") {
      const primary = inspect(resolved.ref);
      if (primary || !tracked || tracked.zoneId === resolved.ref.zone.id) return primary;
    }

    const cfRefs = this.cloudflareRedirectZones(source, tracked);
    const failedCf = this.connections.filter((connection) => !connection.active);
    if (failedCf.length && (tracked ? !cfRefs.some((ref) => ref.zone.id === tracked.zoneId) : !cfRefs.length)) {
      return { problem: `Cloudflare could not be read: ${failedCf.map((c) => c.error).join("; ")}` };
    }
    const hits: { zone: ZoneView; rulesetId: string; rule: CfRuleset["rules"][number] }[] = [];
    for (const ref of cfRefs) {
      const checked = inspect(ref);
      if (!checked) continue;
      if ("problem" in checked) return checked;
      hits.push(checked);
    }
    if (hits.length > 1) {
      return { problem: `Cloudflare redirect rules for ${source} exist in more than one zone; remove the extra rule in Cloudflare first` };
    }
    return hits[0] ?? null;
  }

  async deleteRedirectRule(source: string, zoneId: string, rulesetId: string, ruleId: string, connectionId?: string, detail = `${source}: the redirect domain was deleted`): Promise<void> {
    const ref = this.zoneRefs.find((candidate) => candidate.zone.id === zoneId && (!connectionId || candidate.connectionId === connectionId))!;
    await this.apis.get(ref.connectionId)!.deleteRule(zoneId, REDIRECT_PHASE, rulesetId, ruleId);
    this.logged([source], ref.zone.name, "delete", "Cloudflare redirect rule", detail);
  }

  /** Whole-host redirect rules in every Cloudflare zone the connections reach, each zone read through its first connection. */
  async findRedirects(): Promise<{ redirects: FoundRedirect[]; notes: string[] }> {
    const zones = new Map<string, ZoneRef>();
    for (const ref of this.zoneRefs) {
      if (!INACTIVE_ZONES.has(ref.zone.status) && !zones.has(ref.zone.id)) zones.set(ref.zone.id, ref);
    }
    const read = await Promise.all([...zones.values()].map(async (ref): Promise<{ ref: ZoneRef; rules: CfRuleset["rules"] } | { ref: ZoneRef; error: string }> => {
      try {
        return { ref, rules: (await this.apis.get(ref.connectionId)!.entrypoint(ref.zone.id, REDIRECT_PHASE))?.rules ?? [] };
      } catch (error) {
        return { ref, error: errorMessage(error) };
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
}
