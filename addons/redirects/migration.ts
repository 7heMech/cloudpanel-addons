/**
 * Moves redirect domains, stand-in records, redirect review holds, tracked
 * Cloudflare rules, and matching Cloudflare zone choices out of `addons/dns`
 * into the standalone `redirects` addon on upgrade.
 *
 * Returns an in-memory rollback closure that restores every touched file
 * verbatim and removes newly created Redirects state/config if the update
 * rolls back.
 */
import { existsSync, lstatSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic-write";
import { errorMessage } from "../../lib/errors";
import { addonConfigFile, addonStateDir, ROOT_UID } from "../../lib/paths";
import { readState, writeState } from "../../lib/root-state";
import { isTrustedFile } from "../../lib/trusted-file";
import type { TrackedRedirectRule } from "./engine";
import {
  cloudflareId, connectionId, emptyPolicy, hostname, parsePolicy, parseRedirect, parseRedirects,
  type Policy, type Redirect, type ZoneChoice,
} from "./model";
import { standInHosts } from "./rules";
import type { StandInRecord } from "./stand-in";

interface SavedFile {
  path: string;
  text: string;
  mode: number;
  uid: number;
  gid: number;
}

export interface RedirectsMigrationOptions {
  dnsDir?: string;
  redirectsDir?: string;
  dnsConfigFile?: string;
  redirectsConfigFile?: string;
  rootUid?: number;
  /**
   * DNS's own upgrade of its saved policy, which turns each redirect's mail
   * profile into the domain's Mail role. Passed in so Redirects never imports
   * DNS; without it the redirects are dropped from DNS's policy as they are.
   */
  upgradeDnsPolicy?: (raw: unknown) => Record<string, unknown>;
}

function snapshotFile(path: string, expectedUid: number): SavedFile | null {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!isTrustedFile(info, expectedUid)) throw new Error(`refusing untrusted migration file ${path}`);
  return { path, text: readFileSync(path, "utf8"), mode: info.mode & 0o777, uid: info.uid, gid: info.gid };
}

function restoreFile(file: SavedFile): void {
  writeFileAtomic(file.path, file.text, { mode: file.mode, owner: { uid: file.uid, gid: file.gid }, createParent: true });
}

export function redirectsMigrationPending(dnsDir = addonStateDir("dns")): boolean {
  if (existsSync(join(dnsDir, "standins.json"))) return true;
  try {
    const policyPath = join(dnsDir, "policy.json");
    if (existsSync(policyPath)) {
      const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as { redirects?: unknown };
      if (Array.isArray(parsed?.redirects) && parsed.redirects.length > 0) return true;
    }
  } catch { /* ignore unreadable */ }
  try {
    const statusPath = join(dnsDir, "status.json");
    if (existsSync(statusPath)) {
      const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as { redirectRules?: unknown };
      if (parsed?.redirectRules && typeof parsed.redirectRules === "object" && Object.keys(parsed.redirectRules).length > 0) return true;
    }
  } catch { /* ignore unreadable */ }
  return false;
}

function sameHosts(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((host, index) => host === right[index]);
}

function parseTrackedRules(raw: unknown): Record<string, TrackedRedirectRule> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TrackedRedirectRule> = {};
  for (const [domain, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    try {
      const source = hostname(domain, "a tracked redirect");
      const conn = connectionId(entry.connectionId);
      const zoneId = cloudflareId(entry.zoneId, "a tracked zone");
      const zoneName = hostname(entry.zoneName, "a tracked zone");
      out[source] = { connectionId: conn, zoneId, zoneName };
    } catch { /* skip malformed entry */ }
  }
  return out;
}

/**
 * Migrates redirect domains, stand-ins, holds, and tracked Cloudflare rules out
 * of DNS into the standalone Redirects addon. Enables Redirects when DNS was
 * enabled so live redirects keep reconciling after upgrade.
 */
export function migrateRedirectsFromDns(
  enableRedirects: () => void,
  options: RedirectsMigrationOptions = {},
): (() => void) | null {
  const dnsDir = options.dnsDir ?? addonStateDir("dns");
  const redirectsDir = options.redirectsDir ?? addonStateDir("redirects");
  const dnsConfigFile = options.dnsConfigFile ?? addonConfigFile("dns");
  const redirectsConfigFile = options.redirectsConfigFile ?? addonConfigFile("redirects");
  const uid = options.rootUid ?? ROOT_UID;

  const dnsPolicyPath = join(dnsDir, "policy.json");
  const dnsStatusPath = join(dnsDir, "status.json");
  const dnsStandInsPath = join(dnsDir, "standins.json");
  const redirPolicyPath = join(redirectsDir, "policy.json");
  const redirStatusPath = join(redirectsDir, "status.json");
  const redirStandInsPath = join(redirectsDir, "standins.json");

  let dnsPolicySnap: SavedFile | null;
  let dnsStatusSnap: SavedFile | null;
  let dnsStandInsSnap: SavedFile | null;
  try {
    dnsPolicySnap = snapshotFile(dnsPolicyPath, uid);
    dnsStatusSnap = snapshotFile(dnsStatusPath, uid);
    dnsStandInsSnap = snapshotFile(dnsStandInsPath, uid);
  } catch (error) {
    throw new Error(`DNS's redirect domains were not moved to Redirects: ${errorMessage(error)}`);
  }

  let dnsPolicyJson: Record<string, unknown> | null = null;
  let dnsStatusJson: Record<string, unknown> | null = null;
  let dnsStandInsJson: Record<string, StandInRecord> | null = null;
  try { if (dnsPolicySnap) dnsPolicyJson = JSON.parse(dnsPolicySnap.text) as Record<string, unknown>; } catch { dnsPolicyJson = null; }
  try { if (dnsStatusSnap) dnsStatusJson = JSON.parse(dnsStatusSnap.text) as Record<string, unknown>; } catch { dnsStatusJson = null; }
  try { if (dnsStandInsSnap) dnsStandInsJson = JSON.parse(dnsStandInsSnap.text) as Record<string, StandInRecord>; } catch { dnsStandInsJson = null; }

  const rawLegacyRedirects = Array.isArray(dnsPolicyJson?.redirects) ? dnsPolicyJson!.redirects : [];
  const legacyTracked = parseTrackedRules(dnsStatusJson?.redirectRules);
  const hasStandInsFile = dnsStandInsSnap !== null;
  if (!rawLegacyRedirects.length && !Object.keys(legacyTracked).length && !hasStandInsFile) return null;

  const targetDirExisted = existsSync(redirectsDir);
  const configExisted = existsSync(redirectsConfigFile);
  let configCreated = false;
  const originals = new Map<string, SavedFile | null>();
  const keep = (path: string) => { if (!originals.has(path)) originals.set(path, snapshotFile(path, uid)); };

  const undo = () => {
    for (const [path, before] of [...originals].reverse()) {
      if (before) restoreFile(before); else rmSync(path, { force: true });
    }
    if (configCreated) rmSync(redirectsConfigFile, { force: true });
    if (!targetDirExisted && existsSync(redirectsDir)) {
      try { rmdirSync(redirectsDir); } catch { /* non-empty */ }
    }
  };

  try {
    const dnsZoneChoices = (dnsPolicyJson?.zoneChoices && typeof dnsPolicyJson.zoneChoices === "object" && !Array.isArray(dnsPolicyJson.zoneChoices))
      ? dnsPolicyJson.zoneChoices as Record<string, { connectionId?: unknown; zoneId?: unknown }>
      : {};
    const dnsPlans = (dnsStatusJson?.plans && typeof dnsStatusJson.plans === "object" && !Array.isArray(dnsStatusJson.plans))
      ? dnsStatusJson.plans as Record<string, { redirect?: unknown; zone?: { provider?: unknown } | null }>
      : {};

    const migratedRedirects: Redirect[] = [];
    for (const entry of rawLegacyRedirects) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const raw = entry as Record<string, unknown>;
      const parsed = parseRedirect({
        source: raw.source,
        target: raw.target,
        status: raw.status,
        keepPath: raw.keepPath,
        keepQuery: raw.keepQuery,
      });
      const source = parsed.source;
      const onPowerDns = dnsPlans[source]?.zone?.provider === "powerdns"
        || Object.entries(dnsZoneChoices).some(([zone, choice]) =>
          (source === zone || source.endsWith(`.${zone}`))
          && typeof choice?.connectionId === "string"
          && choice.connectionId.startsWith("pdns-"));
      if (onPowerDns) parsed.mode = "local";
      const standInHostsSaved = dnsStandInsJson?.[source]?.hosts;
      if (Array.isArray(standInHostsSaved) && standInHostsSaved.length && !sameHosts(standInHostsSaved, standInHosts(source))) {
        try {
          const withHosts = parseRedirect({ ...parsed, hosts: standInHostsSaved });
          if (withHosts.hosts) parsed.hosts = withHosts.hosts;
        } catch { /* drop invalid host list */ }
      }
      migratedRedirects.push(parsed);
    }

    const migratedSources = new Set(migratedRedirects.map((redirect) => redirect.source));
    const dnsEnabled = existsSync(dnsConfigFile);
    const existingPolicyRaw = readState<unknown>(redirPolicyPath, uid, () => null);
    const existingPolicy: Policy = existingPolicyRaw === null ? emptyPolicy() : parsePolicy(existingPolicyRaw);
    const existingSources = new Set(existingPolicy.redirects.map((redirect) => redirect.source));
    const mergedRedirects = parseRedirects([
      ...existingPolicy.redirects,
      ...migratedRedirects.filter((redirect) => !existingSources.has(redirect.source)),
    ]);

    const legacyHeld = Array.isArray(dnsPolicyJson?.held)
      ? dnsPolicyJson!.held.filter((domain): domain is string => typeof domain === "string" && migratedSources.has(domain))
      : [];
    const mergedHeld = [...new Set([...existingPolicy.held, ...legacyHeld])];

    const mergedZoneChoices: Record<string, ZoneChoice> = { ...existingPolicy.zoneChoices };
    for (const [rawZone, rawChoice] of Object.entries(dnsZoneChoices)) {
      if (!rawChoice || typeof rawChoice.connectionId !== "string" || rawChoice.connectionId.startsWith("pdns-")) continue;
      try {
        const zone = hostname(rawZone, "a zone");
        if (mergedZoneChoices[zone]) continue;
        if (![...migratedSources].some((source) => source === zone || source.endsWith(`.${zone}`))) continue;
        mergedZoneChoices[zone] = {
          connectionId: connectionId(rawChoice.connectionId),
          zoneId: cloudflareId(rawChoice.zoneId, "a zone"),
        };
      } catch { /* skip non-Cloudflare or invalid choice */ }
    }

    const nextPolicy: Policy = {
      version: 1,
      automatic: existingPolicyRaw !== null ? existingPolicy.automatic : (dnsEnabled && dnsPolicyJson?.automatic === true),
      redirects: mergedRedirects,
      held: mergedHeld,
      zoneChoices: mergedZoneChoices,
    };

    if (mergedRedirects.length || existingPolicyRaw !== null) {
      keep(redirPolicyPath);
      writeState(redirPolicyPath, nextPolicy, uid);
    }

    // Migrate standins.json (existing Redirects records win on duplicate domain).
    if (dnsStandInsJson && Object.keys(dnsStandInsJson).length > 0) {
      const existingStandIns = readState<Record<string, StandInRecord>>(redirStandInsPath, uid, () => ({}));
      keep(redirStandInsPath);
      writeState(redirStandInsPath, { ...dnsStandInsJson, ...existingStandIns }, uid);
    }

    // Migrate tracked Cloudflare redirect rules and Cloudflare connectionIds into redirects/status.json.
    const legacyConnectionIds = Array.isArray(dnsStatusJson?.connectionIds)
      ? dnsStatusJson!.connectionIds.filter((id): id is string => typeof id === "string" && !id.startsWith("pdns-"))
      : undefined;
    if (Object.keys(legacyTracked).length > 0 || legacyConnectionIds !== undefined) {
      const existingStatus = readState<{
        checkedAt?: string | null;
        plans?: Record<string, unknown>;
        connectionIds?: string[];
        redirectRules?: Record<string, TrackedRedirectRule>;
      }>(redirStatusPath, uid, () => ({ checkedAt: null, plans: {} }));
      const nextStatus = {
        checkedAt: existingStatus.checkedAt ?? null,
        plans: existingStatus.plans ?? {},
        ...(existingStatus.connectionIds !== undefined
          ? { connectionIds: existingStatus.connectionIds }
          : legacyConnectionIds !== undefined
            ? { connectionIds: legacyConnectionIds }
            : {}),
        redirectRules: { ...legacyTracked, ...(existingStatus.redirectRules ?? {}) },
      };
      keep(redirStatusPath);
      writeState(redirStatusPath, nextStatus, uid);
    }

    // Enable Redirects when DNS was enabled and had redirect state.
    if (dnsEnabled && !configExisted && (migratedRedirects.length > 0 || (dnsStandInsJson && Object.keys(dnsStandInsJson).length > 0))) {
      enableRedirects();
      configCreated = existsSync(redirectsConfigFile);
    }

    // Clean migrated redirect state out of DNS files.
    if (dnsPolicySnap && dnsPolicyJson && rawLegacyRedirects.length > 0) {
      keep(dnsPolicyPath);
      const nextDnsHeld = Array.isArray(dnsPolicyJson.held)
        ? dnsPolicyJson.held.filter((domain) => typeof domain !== "string" || !migratedSources.has(domain))
        : dnsPolicyJson.held;
      const cleanedDnsPolicy = options.upgradeDnsPolicy ? options.upgradeDnsPolicy(dnsPolicyJson) : { ...dnsPolicyJson };
      delete cleanedDnsPolicy.redirects;
      if (nextDnsHeld !== undefined) cleanedDnsPolicy.held = nextDnsHeld;
      restoreFile({ ...dnsPolicySnap, text: `${JSON.stringify(cleanedDnsPolicy, null, 2)}\n` });
    }
    if (dnsStatusSnap && dnsStatusJson) {
      const hasLegacyRules = Boolean(dnsStatusJson.redirectRules && typeof dnsStatusJson.redirectRules === "object"
        && Object.keys(dnsStatusJson.redirectRules as Record<string, unknown>).length > 0);
      const nextDnsPlans: Record<string, unknown> = {};
      let droppedPlans = false;
      for (const [domain, plan] of Object.entries(dnsPlans)) {
        if (plan?.redirect === true || migratedSources.has(domain)) {
          droppedPlans = true;
          continue;
        }
        nextDnsPlans[domain] = plan;
      }
      if (hasLegacyRules || droppedPlans) {
        keep(dnsStatusPath);
        const cleanedDnsStatus: Record<string, unknown> = { ...dnsStatusJson, plans: nextDnsPlans };
        delete cleanedDnsStatus.redirectRules;
        restoreFile({ ...dnsStatusSnap, text: `${JSON.stringify(cleanedDnsStatus, null, 2)}\n` });
      }
    }
    if (dnsStandInsSnap) {
      keep(dnsStandInsPath);
      rmSync(dnsStandInsPath, { force: true });
    }

    return undo;
  } catch (error) {
    undo();
    throw new Error(`DNS's redirect domains were not moved to Redirects: ${errorMessage(error)}`);
  }
}
