import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

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
