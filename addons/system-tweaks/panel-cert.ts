/**
 * CloudPanel serves its panel on 8443 with one certificate and private key that
 * every install shares (CVE-2023-0391). This swaps that pair for one generated
 * on the box and leaves any other certificate alone. CloudPanel's custom domain
 * does not change it: that domain is served by the sites' Nginx on 443, which
 * proxies to 8443 without verifying it.
 */
import { addonStateDir, ROOT_UID } from "../../lib/paths";
import { X509Certificate, createPrivateKey } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { errorMessage } from "../../lib/errors";
import { failAction } from "../../lib/action";
import { runCommand, type CommandResult } from "../../lib/command";
import { nginxFileChange, withNginxTransaction } from "../../lib/nginx-transaction";
import { writeFileAtomic } from "../../lib/atomic-write";
import { panelUserUid } from "../../lib/sso-auth";
import { COMMAND_MS } from "./limits";

/** CloudPanel's shared certificate, `CN=cloudpanel.clp`. */
export const SHARED_FINGERPRINT = "6D:13:60:EC:EF:D5:01:F8:F4:91:C3:2D:41:91:48:9C:E1:02:3E:C8:E9:12:5D:96:AE:A7:53:03:FB:62:4F:2B";
/** Under Apple's 825-day limit for TLS server certificates. */
const VALID_DAYS = 800;
const RENEW_MS = 30 * 86_400_000;
const MAX_PEM_BYTES = 64 * 1024;
const PANEL_NGINX = "/home/clp/services/nginx";

export const DEFAULT_PANEL_CERT_PATHS = {
  vhost: `${PANEL_NGINX}/sites-enabled/cloudpanel.conf`,
  panelConf: `${PANEL_NGINX}/nginx.conf`,
  cert: `${PANEL_NGINX}/ssl-certificates/cert.crt`,
  key: `${PANEL_NGINX}/ssl-certificates/private.key`,
  /** The generated pair, kept so a CloudPanel update gets the same one back. */
  storedCert: `${addonStateDir("system-tweaks")}/panel-cert.crt`,
  storedKey: `${addonStateDir("system-tweaks")}/panel-cert.key`,
  customDomain: "/etc/.clp_custom_domain",
  customDomainVhost: "/etc/nginx/sites-enabled/custom-domain.conf",
  nginx: "nginx",
  systemctl: "systemctl",
  openssl: "openssl",
  panelUid: null as number | null,
  rootUid: ROOT_UID,
};

export interface PanelCertOptions {
  paths?: Partial<typeof DEFAULT_PANEL_CERT_PATHS>;
  run?: (command: string, args: string[]) => CommandResult;
  now?: () => Date;
  hostname?: () => string;
  addresses?: () => string[];
  sharedFingerprint?: string;
}

export interface PanelCertStatus {
  /** `shared` is CloudPanel's; `generated` came from here; `own` is anything else. */
  kind: "shared" | "generated" | "own" | "unknown";
  subject?: string;
  /** Names and addresses the certificate covers. */
  names?: string[];
  expires?: string;
  fingerprint?: string;
  /** CloudPanel's custom domain, which the sites' Nginx serves with its own certificate. */
  customDomain?: string;
  problem?: string;
}

type Paths = typeof DEFAULT_PANEL_CERT_PATHS;

function pathsOf(options: PanelCertOptions): Paths {
  return { ...DEFAULT_PANEL_CERT_PATHS, ...options.paths };
}

function runOf(options: PanelCertOptions): (command: string, args: string[]) => CommandResult {
  return options.run ?? ((command, args) => runCommand(command, args, COMMAND_MS));
}

/** A small regular file, or null when there is none. Checked on the descriptor it is read from. */
function smallFile(path: string, uids: number[]): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") failAction(`${path} is a symlink`);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_PEM_BYTES) failAction(`${path} is not a regular file`);
    if (!uids.includes(info.uid) || (info.mode & 0o002) !== 0) failAction(`${path} is not a trusted file`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function certificate(pem: string | null): X509Certificate | null {
  if (!pem) return null;
  try { return new X509Certificate(pem); } catch { return null; }
}

function names(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? "").split(", ").map((entry) => entry.replace(/^(?:DNS:|IP Address:)/, "")).filter(Boolean);
}

/** The files the panel's server block names, when they are CloudPanel's own. */
function namesStockFiles(paths: Paths): boolean {
  const vhost = smallFile(paths.vhost, [panelUid(paths), paths.rootUid]);
  if (vhost === null) failAction(`${paths.vhost} is missing`);
  const named = (directive: string) => [...vhost.matchAll(new RegExp(`^[ \\t]*${directive}[ \\t]+(\\S+?)[ \\t]*;`, "gm"))].map((match) => match[1]);
  const certs = named("ssl_certificate");
  const keys = named("ssl_certificate_key");
  return certs.length === 1 && keys.length === 1 && certs[0] === paths.cert && keys[0] === paths.key;
}

function panelUid(paths: Paths): number {
  return paths.panelUid ?? panelUserUid() ?? paths.rootUid;
}

/** The package writes the files as root and CloudPanel hands them to its account; either is kept. */
function ownerOf(paths: Paths, path: string): number {
  try {
    const uid = lstatSync(path).uid;
    if (uid === paths.rootUid) return uid;
  } catch { /* the transaction reports it */ }
  return panelUid(paths);
}

function storedPair(paths: Paths): { cert: string; key: string; parsed: X509Certificate } | null {
  try {
    const cert = smallFile(paths.storedCert, [paths.rootUid]);
    const key = smallFile(paths.storedKey, [paths.rootUid]);
    const parsed = certificate(cert);
    if (!cert || !key || !parsed || !parsed.checkPrivateKey(createPrivateKey(key))) return null;
    return { cert, key, parsed };
  } catch {
    return null;
  }
}

function customDomain(paths: Paths): string | undefined {
  try {
    lstatSync(paths.customDomainVhost);
    const name = (smallFile(paths.customDomain, [panelUid(paths), paths.rootUid]) ?? "").trim();
    return /^[A-Za-z0-9.-]{1,253}$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

export function panelCertStatus(options: PanelCertOptions = {}): PanelCertStatus {
  const paths = pathsOf(options);
  const domain = customDomain(paths);
  const status = (fields: PanelCertStatus): PanelCertStatus => (domain ? { ...fields, customDomain: domain } : fields);
  try {
    if (!namesStockFiles(paths)) return status({ kind: "own" });
    const cert = certificate(smallFile(paths.cert, [panelUid(paths), paths.rootUid]));
    if (!cert) return status({ kind: "unknown", problem: `${paths.cert} holds no certificate` });
    const stored = storedPair(paths);
    const kind = cert.fingerprint256 === (options.sharedFingerprint ?? SHARED_FINGERPRINT) ? "shared"
      : stored?.parsed.fingerprint256 === cert.fingerprint256 ? "generated" : "own";
    return status({
      kind, subject: cert.subject.replace(/\n/g, ", "), names: names(cert),
      expires: cert.validToDate.toISOString(), fingerprint: cert.fingerprint256,
    });
  } catch (error) {
    return status({ kind: "unknown", problem: errorMessage(error) });
  }
}

/** This box's global addresses, for the certificate's alternative names. */
function boxAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((entry) => entry && !entry.internal
    && !/^(?:fe80:|169\.254\.)/i.test(entry.address)).map((entry) => entry!.address);
}

function generate(paths: Paths, options: PanelCertOptions): { cert: string; key: string } {
  const host = (options.hostname ?? hostname)().trim().toLowerCase();
  const dnsName = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : "";
  const addresses = [...new Set((options.addresses ?? boxAddresses)())];
  const alt = [...(dnsName ? [`DNS:${dnsName}`] : []), ...addresses.map((address) => `IP:${address}`)];
  if (!alt.length) failAction("this server has neither a hostname nor an address to name in a certificate");
  const commonName = dnsName.length <= 64 && dnsName ? dnsName : addresses[0]!;
  const config = [
    "[req]", "distinguished_name = dn", "prompt = no", "x509_extensions = ext",
    "[dn]", `CN = ${commonName}`,
    "[ext]", `subjectAltName = ${alt.join(",")}`, "basicConstraints = critical,CA:FALSE",
    "keyUsage = critical,digitalSignature", "extendedKeyUsage = serverAuth", "subjectKeyIdentifier = hash", "",
  ].join("\n");
  const parent = join(paths.storedCert, "..");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(parent, "panel-cert-"));
  try {
    writeFileSync(join(work, "req.cnf"), config, { mode: 0o600 });
    const made = runOf(options)(paths.openssl, [
      "req", "-x509", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256",
      "-days", String(VALID_DAYS), "-config", join(work, "req.cnf"),
      "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem"),
    ]);
    if (!made.ok) failAction(`openssl could not generate a certificate: ${(made.stderr || made.stdout).trim()}`);
    return { cert: readFileSync(join(work, "cert.pem"), "utf8"), key: readFileSync(join(work, "key.pem"), "utf8") };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Puts the generated pair in place of CloudPanel's shared one, or of an expiring
 * generated one, then validates and reloads the panel's Nginx; a failure puts
 * the previous files back. Any other certificate is left alone.
 */
export function replacePanelCert(options: PanelCertOptions = {}): string | null {
  const paths = pathsOf(options);
  const now = (options.now ?? (() => new Date()))().getTime();
  const status = panelCertStatus(options);
  if (status.kind === "unknown") {
    // CloudPanel's older layout, with the panel on the sites' Nginx, is not handled.
    if (!existsSync(paths.vhost)) return null;
    failAction(status.problem ?? "the panel's certificate could not be read");
  }
  const expiring = status.kind === "generated" && Date.parse(status.expires!) - now < RENEW_MS;
  if (status.kind !== "shared" && !expiring) return null;
  const stored = storedPair(paths);
  const reuse = stored && !expiring && stored.parsed.validToDate.getTime() - now >= RENEW_MS;
  const pair = reuse ? stored : generate(paths, options);
  const nginx = { nginx: paths.nginx, systemctl: paths.systemctl, config: paths.panelConf, service: "clp-nginx" };
  withNginxTransaction(null, nginx, runOf(options), (changes) => {
    changes.push(nginxFileChange(paths.key, pair.key, ownerOf(paths, paths.key), true), nginxFileChange(paths.cert, pair.cert, ownerOf(paths, paths.cert), true));
    // Written with the files' own mode, less any access for others.
    for (const change of changes) change.backup.mode &= 0o770;
  });
  if (!reuse) {
    writeFileAtomic(paths.storedKey, pair.key, { mode: 0o600 });
    writeFileAtomic(paths.storedCert, pair.cert, { mode: 0o600 });
  }
  return expiring ? "panel certificate renewed" : "panel's shared certificate replaced";
}
