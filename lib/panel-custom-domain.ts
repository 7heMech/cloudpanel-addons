import { X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { trustedText } from "./trusted-file";

export const PANEL_CUSTOM_DOMAIN_FILE = "/etc/.clp_custom_domain";
export const PANEL_CUSTOM_DOMAIN_VHOST = "/etc/nginx/sites-enabled/custom-domain.conf";

/**
 * CloudPanel's custom domain, which the sites' Nginx serves on 80 and 443 and
 * proxies to the panel: the name CloudPanel wrote, while its vhost exists.
 * Undefined for no custom domain, or a file root should not trust.
 */
export function panelCustomDomain(
  owners: number[],
  file = PANEL_CUSTOM_DOMAIN_FILE,
  vhost = PANEL_CUSTOM_DOMAIN_VHOST,
): string | undefined {
  try {
    lstatSync(vhost);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 1024 || !owners.includes(info.uid) || (info.mode & 0o002) !== 0) return undefined;
      const name = readFileSync(fd, "utf8").trim().toLowerCase();
      return /^[a-z0-9.-]{1,253}$/.test(name) ? name : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export const PANEL_CUSTOM_DOMAIN_CERT = "/etc/nginx/ssl-certificates/custom-domain.crt";

/**
 * Whether `pem` is a certificate a CA issued for `name` and still valid, as
 * opposed to the self-signed one CloudPanel serves while it asks Let's Encrypt.
 */
export function issuedFor(pem: string | null, name: string, now = Date.now()): boolean {
  if (!pem) return false;
  let cert: X509Certificate;
  try { cert = new X509Certificate(pem); } catch { return false; }
  return !cert.checkIssued(cert) && cert.checkHost(name) !== undefined && Date.parse(cert.validTo) > now;
}

/** CloudPanel's custom domain, and whether it serves a certificate issued for it. */
export function panelCustomDomainCertificate(
  owners: number[],
  paths: { file?: string; vhost?: string; cert?: string } = {},
  now = Date.now(),
): { name: string; issued: boolean } | undefined {
  const name = panelCustomDomain(owners, paths.file, paths.vhost);
  if (!name) return undefined;
  const pem = owners.map((uid) => trustedText(paths.cert ?? PANEL_CUSTOM_DOMAIN_CERT, uid)).find((text) => text !== null) ?? null;
  return { name, issued: issuedFor(pem, name, now) };
}
