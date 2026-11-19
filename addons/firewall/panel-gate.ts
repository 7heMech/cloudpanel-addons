/**
 * The Panel gate: only requests that came through Cloudflare for CloudPanel's
 * custom domain, past Cloudflare Access, reach the panel's PHP. Cloudflare
 * presents a client certificate of our own to the sites' Nginx for that
 * hostname alone (per-hostname origin pulls), and the panel's Nginx answers
 * only its loopback proxy. See "Panel gate" in docs/decisions/firewall.md.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { ActionFailure, failAction } from "../../lib/action";
import { runCommand, type CommandResult } from "../../lib/command";
import { errorMessage } from "../../lib/errors";
import { withFileLock, withFileLockSync } from "../../lib/file-lock";
import { nginxFileChange, trustedVhost, withNginxTransaction, withRecoveryFailures } from "../../lib/nginx-transaction";
import { panelCustomDomain, PANEL_CUSTOM_DOMAIN_FILE, PANEL_CUSTOM_DOMAIN_VHOST } from "../../lib/panel-custom-domain";
import { withPanelDb } from "../../lib/panel-db";
import { addonStateDir, LOCK_DIR, nginxLayout, PANEL_DB, ROOT_UID } from "../../lib/paths";
import { ProviderError, type ApiFetch } from "../../lib/provider-http";
import { readState, writeState } from "../../lib/root-state";
import { panelUserGid, panelUserUid } from "../../lib/sso-auth";
import { grants, selfReadPermission, targetFor, tokenListUrl, type TokenOwner } from "../dns/access";
import { CloudflareApi, type CfZone } from "../dns/cloudflare";
import { parseSecrets } from "../dns/model";
import { PERMISSIONS, type PermissionName } from "../dns/token";
import {
  hasPanelGate, hasSitesGate, panelGateMisfit, sitesGateMisfit, withoutPanelGate, withoutSitesGate, withPanelGate, withSitesGate,
} from "./panel-gate-nginx";

/** What Cloudflare must let the token do, beyond DNS's own. */
export const GATE_PERMISSIONS: PermissionName[] = ["originPulls", "accessApps", "accessIdentity"];
/** Names the Access objects the gate owns, so a run that lost its state finds them again; one pair per hostname in an account. */
const markerFor = (hostname: string) => `CloudPanel ${hostname} (clp-addons panel gate)`;
const PANEL_ROLES = ["ROLE_ADMIN", "ROLE_SITE_MANAGER", "ROLE_USER"];
const EMAIL_RE = /^[^\s@"<>]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/;
const CERT_DAYS = 3650;
const DEPLOY_WAIT_MS = 150_000;
const DEPLOY_POLL_MS = 5_000;

interface GatePaths {
  stateFile: string;
  lockFile: string;
  certDir: string;
  dnsDir: string;
  panelDb: string;
  customDomain: string;
  customDomainVhost: string;
  /** Null takes CloudPanel's own panel vhost and config, as cli/inject.ts finds them. */
  panelVhost: string | null;
  panelConf: string | null;
  rootUid: number;
  rootGid: number;
  panelUid: number | null;
  panelGid: number | null;
  nginx: string;
  systemctl: string;
  openssl: string;
}

export const DEFAULT_GATE_PATHS: GatePaths = {
  stateFile: `${addonStateDir("firewall")}/panel-gate.json`,
  lockFile: `${LOCK_DIR}/firewall-panel-gate.lock`,
  certDir: "/etc/clp-addons/panel-gate",
  dnsDir: addonStateDir("dns"),
  panelDb: PANEL_DB,
  customDomain: PANEL_CUSTOM_DOMAIN_FILE,
  customDomainVhost: PANEL_CUSTOM_DOMAIN_VHOST,
  panelVhost: null,
  panelConf: null,
  rootUid: ROOT_UID,
  rootGid: 0,
  panelUid: null,
  panelGid: null,
  nginx: "nginx",
  systemctl: "systemctl",
  openssl: "openssl",
};

export interface GateOptions {
  paths?: Partial<GatePaths>;
  fetch?: ApiFetch;
  run?: (command: string, args: string[]) => CommandResult;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface GateState {
  on: boolean;
  hostname?: string;
  zoneId?: string;
  accountId?: string;
  connectionId?: string;
  certId?: string;
  policyId?: string;
  appId?: string;
  /** Set while the gate is off but Cloudflare still has objects it made. */
  leftover?: boolean;
  /** What the last look at Cloudflare found wrong, and when. */
  drift?: string[];
  checkedAt?: string;
}

function pathsOf(options: GateOptions): GatePaths {
  return { ...DEFAULT_GATE_PATHS, ...options.paths };
}

const runOf = (options: GateOptions) => options.run ?? ((command: string, args: string[]) => runCommand(command, args, 60_000));

function readGate(paths: GatePaths): GateState {
  const raw = readState<Partial<GateState> | null>(paths.stateFile, paths.rootUid, () => null);
  return raw && typeof raw === "object" ? { ...raw, on: raw.on === true } : { on: false };
}

function writeGate(paths: GatePaths, state: GateState): void {
  writeState(paths.stateFile, state, paths.rootUid);
}

const certPath = (paths: GatePaths) => `${paths.certDir}/origin-pull.crt`;
const keyPath = (paths: GatePaths) => `${paths.certDir}/origin-pull.key`;

// --- Nginx ------------------------------------------------------------------

function panelTarget(paths: GatePaths) {
  const layout = nginxLayout();
  const config = paths.panelConf ?? layout.configFile ?? undefined;
  const owned = config !== undefined;
  const panelGid = paths.panelGid ?? panelUserGid();
  return {
    vhost: paths.panelVhost ?? `${layout.sitesDir}/cloudpanel.conf`,
    uid: owned ? [paths.panelUid ?? panelUserUid() ?? paths.rootUid, paths.rootUid] as const : paths.rootUid,
    groupWritable: owned ? [paths.rootGid, ...(panelGid === null ? [] : [panelGid])] : false,
    nginx: { nginx: paths.nginx, systemctl: paths.systemctl, config, service: config ? "clp-nginx" : "nginx" },
  };
}

/** Puts the custom domain's client-certificate check in or takes it out, validated and reloaded; false when nothing changed. */
export function applySitesGate(enabled: boolean, hostname: string | null, options: GateOptions = {}): boolean {
  const paths = pathsOf(options);
  if (!existsSync(paths.customDomainVhost)) {
    if (enabled) failAction("CloudPanel's custom-domain vhost is missing");
    return false;
  }
  return withNginxTransaction(null, { nginx: paths.nginx, systemctl: paths.systemctl }, runOf(options), (changes) => {
    const change = nginxFileChange(paths.customDomainVhost, null, paths.rootUid);
    const content = change.backup.content;
    if (content === null) return;
    change.content = enabled
      ? withSitesGate(content, hostname ?? "", certPath(paths)) ?? failAction(sitesGateMisfit(content, hostname ?? "") ?? "CloudPanel's custom-domain vhost cannot take the gate")
      : withoutSitesGate(content);
    changes.push(change);
  }).changed;
}

/** Puts the panel's loopback-only rule in or takes it out, tested with the panel's own config and reloaded. */
export function applyPanelGate(enabled: boolean, options: GateOptions = {}): boolean {
  const paths = pathsOf(options);
  const target = panelTarget(paths);
  if (!existsSync(target.vhost)) {
    if (enabled) failAction(`the panel's vhost ${target.vhost} is missing`);
    return false;
  }
  return withNginxTransaction(null, target.nginx, runOf(options), (changes) => {
    const change = nginxFileChange(target.vhost, null, target.uid, target.groupWritable);
    const content = change.backup.content;
    if (content === null) return;
    change.content = enabled ? withPanelGate(content) ?? failAction(panelGateMisfit(content) ?? "the panel's vhost cannot take the gate") : withoutPanelGate(content);
    changes.push(change);
  }).changed;
}

/** What is wrong with the gate's Nginx edits on disk, for a gate that is on. */
function nginxDrift(paths: GatePaths, state: GateState, domain: string | undefined): string[] {
  const drift: string[] = [];
  if (domain !== state.hostname) {
    drift.push(domain
      ? `CloudPanel's custom domain is now ${domain}, not ${state.hostname}; turn the gate off and on again to move it.`
      : `CloudPanel no longer has a custom domain; the panel answers only an SSH tunnel to 127.0.0.1:8443.`);
  } else {
    try {
      if (!hasSitesGate(trustedVhost(paths.customDomainVhost, paths.rootUid).content, state.hostname!, certPath(paths))) {
        drift.push(`${state.hostname}'s vhost does not ask for Cloudflare's client certificate; the next repair puts it back.`);
      }
    } catch (error) { drift.push(`${state.hostname}'s vhost could not be read: ${errorMessage(error)}`); }
  }
  const target = panelTarget(paths);
  try {
    if (!hasPanelGate(trustedVhost(target.vhost, target.uid, target.groupWritable).content)) {
      drift.push("Port 8443 answers more than loopback; the next repair puts the rule back.");
    }
  } catch (error) { drift.push(`The panel's vhost could not be read: ${errorMessage(error)}`); }
  if (!existsSync(certPath(paths))) drift.push(`The origin-pull certificate ${certPath(paths)} is missing; Nginx will not start with the gate's lines.`);
  return drift;
}

// --- The certificate --------------------------------------------------------

function writeSecret(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, content); } finally { closeSync(fd); }
}

function removeCertificate(paths: GatePaths): void {
  rmSync(keyPath(paths), { force: true });
  rmSync(certPath(paths), { force: true });
}

/** A new RSA key and self-signed client certificate, root-only. Cloudflare takes a leaf certificate, which Nginx then trusts as itself. */
function generateCertificate(paths: GatePaths, options: GateOptions): { cert: string; key: string } {
  mkdirSync(paths.certDir, { recursive: true, mode: 0o700 });
  const dir = lstatSync(paths.certDir);
  if (!dir.isDirectory() || dir.uid !== paths.rootUid || (dir.mode & 0o077) !== 0) failAction(`${paths.certDir} must be a directory only root can open`);
  removeCertificate(paths);
  const run = runOf(options);
  const generated = run(paths.openssl, ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"]);
  const key = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n?/.exec(generated.stdout)?.[0];
  if (!generated.ok || !key) failAction(`openssl could not make the origin-pull key: ${(generated.stderr || "no key in its output").trim()}`);
  writeSecret(keyPath(paths), key.endsWith("\n") ? key : `${key}\n`);
  const signed = run(paths.openssl, [
    "req", "-x509", "-new", "-key", keyPath(paths), "-days", String(CERT_DAYS), "-subj", "/CN=clp-addons panel gate",
    "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=clientAuth",
  ]);
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/.exec(signed.stdout)?.[0];
  if (!signed.ok || !cert) {
    removeCertificate(paths);
    failAction(`openssl could not make the origin-pull certificate: ${(signed.stderr || "no certificate in its output").trim()}`);
  }
  writeSecret(certPath(paths), cert.endsWith("\n") ? cert : `${cert}\n`);
  return { cert, key };
}

// --- Cloudflare -------------------------------------------------------------

interface Connection { id: string; label: string; token: string }

function connections(paths: GatePaths): Connection[] {
  const secrets = parseSecrets(readState(`${paths.dnsDir}/secrets.json`, paths.rootUid, () => ({})));
  const policy = readState<{ connections?: unknown } | null>(`${paths.dnsDir}/policy.json`, paths.rootUid, () => null);
  const labels = new Map<string, string>();
  for (const entry of Array.isArray(policy?.connections) ? policy.connections : []) {
    const { id, label } = (entry ?? {}) as { id?: unknown; label?: unknown };
    if (typeof id === "string") labels.set(id, typeof label === "string" ? label : id);
  }
  return Object.entries(secrets.cloudflare).map(([id, token]) => ({ id, label: labels.get(id) ?? id, token }));
}

function apiFor(connection: Connection, options: GateOptions): CloudflareApi {
  return new CloudflareApi(connection.token, options.fetch);
}

interface Found { connection: Connection; api: CloudflareApi; zone: CfZone }

/** The longest active zone any DNS connection reaches for the hostname. */
async function findZone(hostname: string, list: Connection[], options: GateOptions): Promise<{ found: Found | null; errors: string[] }> {
  let found: Found | null = null;
  const errors: string[] = [];
  const read = await Promise.all(list.map(async (connection) => {
    const api = apiFor(connection, options);
    try { return { connection, api, zones: await api.zones() }; }
    catch (error) { errors.push(`${connection.label}: ${errorMessage(error)}`); return { connection, api, zones: [] }; }
  }));
  for (const { connection, api, zones } of read) {
    for (const zone of zones) {
      if (zone.status !== "active" || (hostname !== zone.name && !hostname.endsWith(`.${zone.name}`))) continue;
      if (!found || zone.name.length > found.zone.name.length) found = { connection, api, zone };
    }
  }
  return { found, errors };
}

/** The gate's permissions the token lacks for this zone, or why that cannot be told. */
async function missingPermissions(api: CloudflareApi, zone: CfZone): Promise<{ missing: string[]; owner: TokenOwner | null }> {
  const verified = await api.verify();
  const owner = { owner: verified.owner, accountId: verified.accountId };
  if (!verified.active || !verified.id) return { missing: ["an active token"], owner };
  let list;
  try {
    list = await api.policies(owner, verified.id);
  } catch (error) {
    if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) return { missing: [selfReadPermission(owner.owner)], owner };
    throw error;
  }
  const target = { id: zone.id, accountId: zone.account.id };
  const missing = GATE_PERMISSIONS.map((name) => PERMISSIONS[name])
    .filter((permission) => !grants(list, permission, targetFor(permission, target, owner)))
    .map((permission) => permission.label);
  return { missing, owner };
}

function panelEmails(paths: GatePaths): string[] {
  if (!existsSync(paths.panelDb)) return [];
  const rows = withPanelDb(paths.panelDb, (db) => db.query<{ email: string | null }, string[]>(
    `SELECT email FROM user WHERE status = 1 AND role IN (${PANEL_ROLES.map(() => "?").join(", ")})`,
  ).all(...PANEL_ROLES));
  return [...new Set(rows.map((row) => String(row.email ?? "").trim().toLowerCase()).filter((email) => EMAIL_RE.test(email)))].sort();
}

function customDomain(paths: GatePaths): string | undefined {
  return panelCustomDomain([paths.rootUid, paths.panelUid ?? panelUserUid() ?? paths.rootUid], paths.customDomain, paths.customDomainVhost);
}

interface GateCheck {
  hostname: string | null;
  /** Why the gate cannot be turned on; empty when it can. */
  problems: string[];
  notes: string[];
  emails: string[];
  found: Found | null;
  editUrl: string | null;
}

/** Everything turning the gate on decides from: local files, then what Cloudflare says. Writes nothing. */
async function check(options: GateOptions): Promise<GateCheck> {
  const paths = pathsOf(options);
  const problems: string[] = [];
  const notes: string[] = [];
  const hostname = customDomain(paths) ?? null;
  const result: GateCheck = { hostname, problems, notes, emails: [], found: null, editUrl: null };
  if (!hostname) {
    problems.push("CloudPanel has no custom domain. Add one under Admin → Settings, in a zone on Cloudflare.");
    return result;
  }
  try {
    const misfit = sitesGateMisfit(trustedVhost(paths.customDomainVhost, paths.rootUid).content, hostname);
    if (misfit) problems.push(`${misfit}.`);
  } catch (error) { problems.push(`CloudPanel's custom-domain vhost cannot be changed: ${errorMessage(error)}`); }
  const target = panelTarget(paths);
  try {
    const misfit = panelGateMisfit(trustedVhost(target.vhost, target.uid, target.groupWritable).content);
    if (misfit) problems.push(`${misfit[0]!.toUpperCase()}${misfit.slice(1)}.`);
  } catch (error) { problems.push(`The panel's vhost cannot be changed: ${errorMessage(error)}`); }
  try {
    result.emails = panelEmails(paths);
    if (!result.emails.length) problems.push("No active panel user has an email address for Cloudflare Access to send a code to.");
  } catch (error) { problems.push(`The panel users could not be read: ${errorMessage(error)}`); }

  const list = connections(paths);
  if (!list.length) {
    problems.push(`Connect a Cloudflare token in DNS that reaches the zone of ${hostname}.`);
    return result;
  }
  const { found, errors } = await findZone(hostname, list, options);
  if (!found) {
    problems.push(errors.length
      ? `Cloudflare could not be read: ${errors.join("; ")}`
      : `No DNS connection's token reaches a Cloudflare zone for ${hostname}.`);
    return result;
  }
  result.found = found;
  const { api, zone, connection } = found;
  const [records, permissions, mode] = await Promise.allSettled([
    api.recordsAt(zone.id, hostname), missingPermissions(api, zone), api.setting(zone.id, "ssl"),
  ]);
  if (records.status === "rejected") problems.push(`${hostname}'s records could not be read: ${errorMessage(records.reason)}`);
  else {
    const proxyable = records.value.filter((record) => ["A", "AAAA", "CNAME"].includes(record.type));
    if (!proxyable.length) problems.push(`${hostname} has no A, AAAA or CNAME record in Cloudflare.`);
    else if (proxyable.some((record) => !record.proxied)) problems.push(`${hostname} is not proxied through Cloudflare. Turn on the orange cloud for its record.`);
  }
  if (permissions.status === "rejected") problems.push(`The token's permissions could not be read: ${errorMessage(permissions.reason)}`);
  else {
    const { missing, owner } = permissions.value;
    if (owner) result.editUrl = tokenListUrl(owner);
    if (missing.length) problems.push(`The token of DNS connection ${connection.label} lacks ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"} to the token in Cloudflare.`);
  }
  if (mode.status === "rejected") {
    notes.push(`The zone's SSL mode could not be read; it must be Full or Full (strict), or the panel stops answering at ${hostname}.`);
  } else if (mode.value === "off" || mode.value === "flexible") {
    problems.push(`Zone ${zone.name} uses SSL mode ${mode.value === "off" ? "Off" : "Flexible"}, so Cloudflare reaches this server over plain HTTP. Set it to Full (strict).`);
  }
  return result;
}

// --- Turning it on and off --------------------------------------------------

export interface GateReview {
  title: string;
  text: string;
  details: string[];
  confirmLabel: string;
  danger: boolean;
  digest: string;
}

function reviewOf(enabled: boolean, fields: Omit<GateReview, "digest">): GateReview {
  const digest = createHash("sha256").update(JSON.stringify({ enabled, ...fields })).digest("hex").slice(0, 32);
  return { ...fields, digest };
}

/** Where an operator deletes what the gate made, when its token cannot. */
const LEFTOVER_BY_HAND = (hostname: string | undefined) => `If the DNS connection's token can no longer delete them, delete the Access application and policy named ${hostname ? `“${markerFor(hostname)}”` : "after the gate"} under Zero Trust → Access, and the certificate under SSL/TLS → Origin Server → Authenticated Origin Pulls for that hostname, in Cloudflare's dashboard.`;

function leftoverText(state: GateState): string {
  const what = [state.appId ? "Access application" : "", state.policyId ? "Access policy" : "", state.certId ? "origin-pull certificate" : ""].filter(Boolean);
  return `Cloudflare still has the gate's ${what.join(", ")}${state.hostname ? ` for ${state.hostname}` : ""}. Access still asks for a sign-in there, which nothing at this server enforces any more. While Firewall is enabled, its next repair (clp-addons repair firewall) deletes them.`;
}

const WAY_BACK = "If you are shut out, an SSH tunnel to 127.0.0.1:8443 still reaches the panel, and clp-addons firewall panel-gate off, as root, takes the gate off this server.";

async function withGateLock<T>(paths: GatePaths, body: () => Promise<T>): Promise<T> {
  return withFileLock(paths.lockFile, 300, "another Panel gate change is running", body);
}

/** Waits until Cloudflare presents the certificate for the hostname; Nginx must not ask for it sooner. */
async function waitDeployed(api: CloudflareApi, zoneId: string, hostname: string, certId: string, options: GateOptions): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const deadline = now() + DEPLOY_WAIT_MS;
  let polls = 0;
  for (;;) {
    let auth = null;
    try {
      auth = await api.hostnameAuth(zoneId, hostname);
    } catch (error) {
      // A rate limit, a 5xx or a dropped connection is asked again until the deadline.
      if (!(error instanceof ProviderError) || (error.status !== 0 && error.status !== 429 && error.status < 500)) throw error;
    }
    if (auth?.certId === certId && auth.enabled === true && auth.status === "active" && (!auth.certStatus || auth.certStatus === "active")) return;
    if (auth && /timed_out/.test(`${auth.status} ${auth.certStatus}`)) failAction("Cloudflare timed out deploying the origin-pull certificate; try again");
    // Polls are counted too, so a clock that does not move still ends the wait.
    if (now() >= deadline || ++polls > DEPLOY_WAIT_MS / DEPLOY_POLL_MS) {
      failAction("Cloudflare has not finished deploying the origin-pull certificate; try again in a few minutes");
    }
    await sleep(DEPLOY_POLL_MS);
  }
}

async function ensureIdentityProvider(api: CloudflareApi, accountId: string): Promise<string> {
  const existing = (await api.identityProviders(accountId)).find((idp) => idp.type === "onetimepin");
  return existing?.id ?? api.createIdentityProvider(accountId, "One-time PIN", "onetimepin");
}

function appBody(hostname: string, idp: string, policyId: string): Record<string, unknown> {
  return {
    name: markerFor(hostname), domain: hostname, type: "self_hosted", session_duration: "24h",
    allowed_idps: [idp], auto_redirect_to_identity: true, app_launcher_visible: false,
    policies: [{ id: policyId, precedence: 1 }],
  };
}

type Undo = { label: string; run: () => Promise<unknown> | unknown };

async function unwind(undo: Undo[]): Promise<string[]> {
  const failures: string[] = [];
  for (const step of undo.reverse()) {
    try { await step.run(); } catch (error) { failures.push(`${step.label}: ${errorMessage(error)}`); }
  }
  return failures;
}

async function turnOn(paths: GatePaths, found: Found, hostname: string, emails: string[], options: GateOptions): Promise<void> {
  const { api, zone, connection } = found;
  const accountId = zone.account.id;
  const state: GateState = { on: false, hostname, zoneId: zone.id, accountId, connectionId: connection.id, leftover: true };
  const undo: Undo[] = [];
  const save = () => writeGate(paths, state);
  const marker = markerFor(hostname);
  // Each undo is registered before its call, so a change Cloudflare made but whose reply was lost is still undone.
  try {
    const { cert, key } = generateCertificate(paths, options);
    undo.push({ label: "origin-pull certificate files", run: () => removeCertificate(paths) });
    undo.push({
      label: "Cloudflare origin-pull certificate",
      run: async () => {
        const ids = state.certId ? [state.certId]
          : (await api.hostnameCertificates(zone.id)).filter((entry) => entry.certificate.trim() === cert.trim()).map((entry) => entry.id);
        for (const id of ids) await api.deleteHostnameCertificate(zone.id, id);
        delete state.certId;
      },
    });
    state.certId = (await api.uploadHostnameCertificate(zone.id, cert, key)).id;
    save();
    const certId = state.certId;
    undo.push({
      label: "origin pulls for the hostname",
      run: async () => {
        const auth = await api.hostnameAuth(zone.id, hostname);
        if (auth?.certId === certId) await api.setHostnameAuth(zone.id, hostname, certId, null);
      },
    });
    await api.setHostnameAuth(zone.id, hostname, certId, true);
    await waitDeployed(api, zone.id, hostname, certId, options);

    const idp = await ensureIdentityProvider(api, accountId);
    undo.push({
      label: "Access policy",
      run: async () => {
        const id = state.policyId ?? (await api.accessPolicies(accountId)).find((entry) => entry.name === marker)?.id;
        if (id) await api.deleteAccessPolicy(accountId, id);
        delete state.policyId;
      },
    });
    const policy = (await api.accessPolicies(accountId)).find((entry) => entry.name === marker)
      ?? await api.createAccessPolicy(accountId, marker, emails);
    state.policyId = policy.id;
    save();
    if (policy.emails.join() !== emails.join()) await api.updateAccessPolicy(accountId, policy.id, marker, emails);
    undo.push({
      label: "Access application",
      run: async () => {
        const id = state.appId ?? (await api.accessApps(accountId, hostname)).find((app) => app.domain === hostname && app.name === marker)?.id;
        if (id) await api.deleteAccessApp(accountId, id);
        delete state.appId;
      },
    });
    const existing = (await api.accessApps(accountId, hostname)).find((app) => app.domain === hostname && app.name === marker);
    if (existing) {
      state.appId = existing.id;
      save();
    }
    const app = existing ? await api.updateAccessApp(accountId, existing.id, appBody(hostname, idp, policy.id)) : await api.createAccessApp(accountId, appBody(hostname, idp, policy.id));
    state.appId = app.id;
    save();

    undo.push({ label: `${hostname}'s vhost`, run: () => applySitesGate(false, null, options) });
    applySitesGate(true, hostname, options);
    undo.push({ label: "the panel's vhost", run: () => applyPanelGate(false, options) });
    applyPanelGate(true, options);
    writeGate(paths, { ...state, on: true, leftover: undefined, drift: [], checkedAt: new Date((options.now ?? Date.now)()).toISOString() });
  } catch (error) {
    const failures = await unwind(undo);
    state.leftover = Boolean(state.certId || state.appId || state.policyId) || undefined;
    try { writeGate(paths, state); } catch (saveError) { failures.push(`gate state: ${errorMessage(saveError)}`); }
    throw withRecoveryFailures(error, "rollback failed", failures);
  }
}

/** Deletes what Cloudflare still has of the gate; what fails stays recorded for the next repair. */
async function cleanUpCloudflare(paths: GatePaths, state: GateState, options: GateOptions, fallback?: Found): Promise<string[]> {
  if (!state.certId && !state.appId && !state.policyId) {
    if (state.leftover) writeGate(paths, { ...state, leftover: undefined });
    return [];
  }
  const connection = connections(paths).find((entry) => entry.id === state.connectionId);
  // Another DNS connection that reaches the same zone and account can delete them too.
  const api = connection ? apiFor(connection, options)
    : fallback && fallback.zone.id === state.zoneId && fallback.zone.account.id === state.accountId ? fallback.api : null;
  if (!api || !state.zoneId || !state.accountId) return ["no DNS connection reaches the zone they are in"];
  const failures: string[] = [];
  const step = async (label: string, run: () => Promise<unknown>, done: () => void) => {
    try { await run(); done(); } catch (error) { failures.push(`${label}: ${errorMessage(error)}`); }
  };
  if (state.appId) await step("Access application", () => api.deleteAccessApp(state.accountId!, state.appId!), () => { delete state.appId; });
  if (state.policyId && !state.appId) await step("Access policy", () => api.deleteAccessPolicy(state.accountId!, state.policyId!), () => { delete state.policyId; });
  if (state.certId && state.hostname) {
    await step("origin pulls", async () => {
      const auth = await api.hostnameAuth(state.zoneId!, state.hostname!);
      if (auth?.certId === state.certId) await api.setHostnameAuth(state.zoneId!, state.hostname!, state.certId!, null);
      await api.deleteHostnameCertificate(state.zoneId!, state.certId!);
    }, () => { delete state.certId; });
  }
  state.leftover = Boolean(state.certId || state.appId || state.policyId) || undefined;
  writeGate(paths, state);
  return failures;
}

/** Takes the Nginx parts out, panel first, without asking Cloudflare anything. */
function nginxOff(paths: GatePaths, options: GateOptions): void {
  applyPanelGate(false, options);
  applySitesGate(false, null, options);
  removeCertificate(paths);
}

export type GateReply = { review: GateReview } | { notice: string };

/** The switch. Each refusal is decided here; the page only shows the review and sends back its digest. */
export async function setPanelGate(enabled: boolean, confirm: unknown, options: GateOptions = {}): Promise<GateReply> {
  const paths = pathsOf(options);
  return withGateLock(paths, async () => {
    const state = readGate(paths);
    if (enabled && state.on) return { notice: "The Panel gate is already on." };
    if (!enabled && !state.on) return { notice: "The Panel gate is already off." };
    if (!enabled) {
      const review = reviewOf(false, {
        title: "Turn off the Panel gate?",
        text: `Anyone who can reach this server can open the panel's login page again, ${state.hostname ? `at https://${state.hostname} without Cloudflare Access and ` : ""}at https://<this server's IP>:8443. Firewall then deletes the Access application and the origin-pull certificate from Cloudflare; what it cannot delete is retried by repair.`,
        details: [], confirmLabel: "Turn off", danger: false,
      });
      if (confirm !== review.digest) return { review };
      nginxOff(paths, options);
      const next: GateState = { ...state, on: false, leftover: true, drift: undefined, checkedAt: undefined };
      writeGate(paths, next);
      const failures = await cleanUpCloudflare(paths, next, options);
      return {
        notice: failures.length
          ? `The Panel gate is off on this server. Cloudflare still has some of it, which the next repair deletes: ${failures.join("; ")}`
          : "The Panel gate is off.",
      };
    }
    if (state.leftover) nginxOff(paths, options);
    const found = await check(options);
    if (found.problems.length) failAction(`The Panel gate cannot be turned on yet. ${found.problems.join(" ")}`);
    const hostname = found.hostname!;
    if (state.leftover) {
      // Turning on starts a new record, so what an earlier gate left must be gone from Cloudflare first.
      const failures = await cleanUpCloudflare(paths, state, options, found.found!);
      if (failures.length) {
        failAction(`Cloudflare still has the Access application or origin-pull certificate of the earlier gate, which could not be deleted: ${failures.join("; ")}. ${LEFTOVER_BY_HAND(state.hostname)}`);
      }
    }
    const review = reviewOf(true, {
      title: "Turn on the Panel gate?",
      text: [
        `CloudPanel will answer only at https://${hostname}, through Cloudflare, after a Cloudflare Access sign-in: Access emails a one-time code to the address you enter, which must be one of the panel users' below.`,
        `Opening the panel at https://<this server's IP>:8443 stops working.`,
        WAY_BACK,
        ...found.notes,
      ].join(" "),
      details: found.emails, confirmLabel: "Turn on", danger: true,
    });
    if (confirm !== review.digest) return { review };
    try {
      await turnOn(paths, found.found!, hostname, found.emails, options);
    } catch (error) {
      if (error instanceof ActionFailure) throw error;
      failAction(`The Panel gate could not be turned on, and what it had done was undone: ${errorMessage(error)}`);
    }
    return { notice: `The Panel gate is on. CloudPanel answers only at https://${hostname}, after a Cloudflare Access sign-in.` };
  });
}

/** `clp-addons firewall panel-gate off`: the way back in when Cloudflare is the problem. Leaves Cloudflare's objects for repair to delete. */
export async function panelGateOffLocally(options: GateOptions = {}): Promise<string> {
  const paths = pathsOf(options);
  return withGateLock(paths, async () => {
    const state = readGate(paths);
    const panel = applyPanelGate(false, options);
    const sites = applySitesGate(false, null, options);
    removeCertificate(paths);
    const left = Boolean(state.certId || state.appId || state.policyId);
    if (state.on || left) writeGate(paths, { ...state, on: false, leftover: left || undefined, drift: undefined, checkedAt: undefined });
    const cloudflare = left ? ` ${leftoverText(state)} ${LEFTOVER_BY_HAND(state.hostname)}` : "";
    if (state.on) {
      return `The Panel gate is off on this server: port 8443 answers any address again, and ${state.hostname ?? "the custom domain"} no longer asks for Cloudflare's certificate.${cloudflare}`;
    }
    return `The Panel gate was already off.${panel || sites ? " Nginx lines it had left were removed." : ""}${cloudflare}`;
  });
}

// --- Keeping it --------------------------------------------------------------

/** The Nginx parts put back, for the anchor watcher and repair; touches nothing when the custom domain moved. */
export function keepPanelGateNginx(options: GateOptions = {}): string | null {
  const paths = pathsOf(options);
  if (!existsSync(paths.stateFile)) return null;
  return withFileLockSync(paths.lockFile, 300, "another Panel gate change is running", () => {
    const state = readGate(paths);
    if (!state.on) return null;
    const changed: string[] = [];
    if (applyPanelGate(true, options)) changed.push("port 8443 loopback only");
    if (customDomain(paths) === state.hostname && existsSync(certPath(paths)) && applySitesGate(true, state.hostname!, options)) {
      changed.push(`${state.hostname} asks for Cloudflare's certificate`);
    }
    return changed.length ? `Panel gate put back: ${changed.join(", ")}` : null;
  });
}

/** What Cloudflare has of a gate that is on, against what it should; syncs the policy's emails with the panel users. */
async function cloudflareDrift(paths: GatePaths, state: GateState, options: GateOptions): Promise<{ drift: string[]; synced: boolean }> {
  const connection = connections(paths).find((entry) => entry.id === state.connectionId);
  if (!connection) return { drift: ["The DNS connection the gate was turned on with is gone, so Cloudflare cannot be checked."], synced: false };
  const api = apiFor(connection, options);
  const drift: string[] = [];
  let synced = false;
  const zone = { id: state.zoneId!, name: "", status: "active", nameServers: [], account: { id: state.accountId!, name: "" } };
  try {
    const { missing } = await missingPermissions(api, zone);
    if (missing.length) drift.push(`The token of DNS connection ${connection.label} lacks ${missing.join(", ")}.`);
  } catch (error) { drift.push(`The token's permissions could not be read: ${errorMessage(error)}`); }
  try {
    const auth = await api.hostnameAuth(state.zoneId!, state.hostname!);
    if (auth?.certId !== state.certId || auth?.enabled !== true) drift.push(`Cloudflare no longer presents the origin-pull certificate for ${state.hostname}, so the panel does not answer there.`);
  } catch (error) { drift.push(`Origin pulls could not be read: ${errorMessage(error)}`); }
  try {
    const app = state.appId ? await api.accessApp(state.accountId!, state.appId) : null;
    if (!app) drift.push(`The Access application for ${state.hostname} is missing, so Cloudflare asks no one to sign in.`);
    else if (app.domain !== state.hostname || !app.policies.includes(state.policyId ?? "")) drift.push(`The Access application for ${state.hostname} was changed in Cloudflare.`);
    const policy = state.policyId ? await api.accessPolicy(state.accountId!, state.policyId) : null;
    if (!policy) drift.push("The Access policy that lists the panel users is missing.");
    else {
      if (policy.decision !== "allow" || policy.otherRules) drift.push("The Access policy that lists the panel users was changed in Cloudflare.");
      const emails = panelEmails(paths);
      if (emails.length && policy.emails.join() !== emails.join()) {
        await api.updateAccessPolicy(state.accountId!, policy.id, markerFor(state.hostname!), emails);
        synced = true;
      }
    }
  } catch (error) { drift.push(`Cloudflare Access could not be read: ${errorMessage(error)}`); }
  return { drift, synced };
}

/** Repair: the Nginx parts, the Access policy's emails and the drift the page shows; or the clean-up a gate turned off left. */
export async function repairPanelGate(options: GateOptions = {}): Promise<string | null> {
  const paths = pathsOf(options);
  if (!existsSync(paths.stateFile)) return null;
  let line: string | null = null;
  let nginxFailure: string | null = null;
  try { line = keepPanelGateNginx(options); }
  catch (error) { nginxFailure = `The gate's Nginx edits could not be put back: ${errorMessage(error)}`; }
  return withGateLock(paths, async () => {
    const state = readGate(paths);
    if (!state.on) {
      // A run that stopped part way may have left an edit that asks for a certificate Cloudflare is about to forget.
      try { nginxOff(paths, options); }
      catch (error) { throw new Error(`Panel gate: its Nginx lines could not be taken out, so its Cloudflare objects are kept: ${errorMessage(error)}`); }
      if (!state.leftover) return line;
      const failures = await cleanUpCloudflare(paths, state, options);
      if (failures.length) throw new Error(`Panel gate: Cloudflare still has some of it: ${failures.join("; ")}`);
      return "Panel gate: its Cloudflare objects are deleted";
    }
    let found: Awaited<ReturnType<typeof cloudflareDrift>>;
    try { found = await cloudflareDrift(paths, state, options); }
    catch (error) { found = { drift: [`Cloudflare could not be checked: ${errorMessage(error)}`], synced: false }; }
    const drift = [...nginxFailure ? [nginxFailure] : [], ...found.drift];
    writeGate(paths, { ...state, drift, checkedAt: new Date((options.now ?? Date.now)()).toISOString() });
    if (nginxFailure) throw new Error(`Panel gate: ${nginxFailure}`);
    return [line, found.synced ? "Panel gate: Access policy follows the panel users" : null].filter(Boolean).join("; ") || null;
  });
}

/**
 * Disabling Firewall turns the gate off: the Nginx parts now, and what
 * Cloudflare has of it recorded for `cleanUpPanelGate`. Enabling Firewall
 * again leaves it off until the operator turns it on.
 */
export function withdrawPanelGate(options: GateOptions = {}): boolean {
  const paths = pathsOf(options);
  if (!existsSync(paths.stateFile)) return false;
  return withFileLockSync(paths.lockFile, 300, "another Panel gate change is running", () => {
    const state = readGate(paths);
    nginxOff(paths, options);
    const left = Boolean(state.certId || state.appId || state.policyId);
    if (state.on || left) writeGate(paths, { ...state, on: false, leftover: left || undefined, drift: undefined, checkedAt: undefined });
    return left;
  });
}

/** Deletes what Cloudflare still has of a gate that is off; the failures, for `panel-gate-cleanup`. */
export async function cleanUpPanelGate(options: GateOptions = {}): Promise<{ notice: string }> {
  const paths = pathsOf(options);
  if (!existsSync(paths.stateFile)) return { notice: "The Panel gate left nothing in Cloudflare." };
  return withGateLock(paths, async () => {
    const state = readGate(paths);
    if (state.on) failAction("The Panel gate is on; turn it off first");
    const failures = await cleanUpCloudflare(paths, state, options);
    if (failures.length) failAction(`${leftoverText(state)} They could not be deleted now: ${failures.join("; ")}. ${LEFTOVER_BY_HAND(state.hostname)}`);
    return { notice: "The Panel gate left nothing in Cloudflare." };
  });
}

// --- What the page shows ----------------------------------------------------

export interface PanelGateView {
  on: boolean;
  hostname: string | null;
  /** While off: why it cannot be turned on. */
  problems: string[];
  /** While on: what differs from what the gate set up. */
  drift: string[];
  checkedAt: string | null;
  /** Cloudflare still has objects of a gate turned off. */
  leftover: boolean;
  /** Where the DNS connection's token is edited, when known. */
  editUrl: string | null;
  /** Off, and what it needs not read from Cloudflare yet. */
  pending?: boolean;
}

/** What an administrator must act on while the gate is on, without calling Cloudflare: for the Setup checklist. */
export function panelGateActionNeeded(options: GateOptions = {}): string[] {
  const paths = pathsOf(options);
  const state = readGate(paths);
  return state.on ? [...nginxDrift(paths, state, customDomain(paths)), ...state.drift ?? []] : [];
}

/** The card as the page first draws it, without Cloudflare; a gate that is off is then read in full by `panelGateView`. */
export function panelGateSummary(options: GateOptions = {}): PanelGateView {
  const paths = pathsOf(options);
  const state = readGate(paths);
  if (state.on) {
    return {
      on: true, hostname: state.hostname ?? null, problems: [], drift: panelGateActionNeeded(options),
      checkedAt: state.checkedAt ?? null, leftover: false, editUrl: null,
    };
  }
  return {
    on: false, hostname: customDomain(paths) ?? null, problems: [], drift: [], checkedAt: null,
    leftover: Boolean(state.leftover), editUrl: null, pending: true,
  };
}

export async function panelGateView(options: GateOptions = {}): Promise<PanelGateView> {
  const paths = pathsOf(options);
  const state = readGate(paths);
  if (state.on) {
    return {
      on: true, hostname: state.hostname ?? null, problems: [],
      drift: panelGateActionNeeded(options),
      checkedAt: state.checkedAt ?? null, leftover: false, editUrl: null,
    };
  }
  const found = await check(options);
  return {
    on: false, hostname: found.hostname, problems: found.problems, drift: [], checkedAt: null,
    leftover: Boolean(state.leftover), editUrl: found.editUrl,
  };
}
