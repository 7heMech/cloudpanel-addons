// The panel's own hostname and aliases, which no site action may act on.
import { lstatSync, readFileSync } from "node:fs";
import { failAction } from "./action";
import { PANEL_IDENTITY_PATH } from "./paths";
import { HOSTNAME_RE, WILDCARD_HOSTNAME_RE, matchesEntire } from "./validate";

interface PanelIdentity {
  primary: string;
  aliases: string[];
}

export function normalizeIdentityHostname(value: string): string | null {
  let host = value.toLowerCase();
  if (host.includes("..")) return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  return matchesEntire(HOSTNAME_RE, host) || matchesEntire(WILDCARD_HOSTNAME_RE, host) ? host : null;
}

export function parsePanelIdentity(content: string): PanelIdentity | null {
  let primary = "";
  const aliases: string[] = [];
  let seenPrimary = false;
  let seenAliases = false;

  for (const line of content.split("\n")) {
    if (line.replace(/[\s]/g, "") === "" || /^\s*#/.test(line)) continue;
    const separator = line.indexOf("=");
    if (separator === -1) return null;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "PRIMARY") {
      if (seenPrimary) return null;
      // An empty PRIMARY is the catch-all panel: CloudPanel ships the vhost as
      // `server_name _;` and only gains a hostname when an operator sets one.
      // There is then no panel domain for a site to collide with, which is a
      // real state to record rather than a parse failure.
      if (value.trim() === "") {
        primary = "";
        seenPrimary = true;
        continue;
      }
      const host = normalizeIdentityHostname(value);
      if (!host || !matchesEntire(HOSTNAME_RE, host)) return null;
      primary = host;
      seenPrimary = true;
    } else if (key === "ALIASES") {
      if (seenAliases) return null;
      const rawAliases = value.trim() ? value.trim().split(/\s+/) : [];
      for (const raw of rawAliases) {
        const host = normalizeIdentityHostname(raw);
        if (!host) return null;
        aliases.push(host);
      }
      seenAliases = true;
    } else {
      return null;
    }
  }

  return seenPrimary && seenAliases ? { primary, aliases } : null;
}

export function readPanelIdentity(path = PANEL_IDENTITY_PATH): PanelIdentity | null {
  let stat;
  try {
    stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return null;
  } catch {
    return null;
  }

  try {
    return parsePanelIdentity(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function panelIdentityMatches(candidate: string, identity: PanelIdentity): boolean {
  if (identity.primary !== "" && candidate === identity.primary) return true;
  for (const alias of identity.aliases) {
    if (alias.startsWith("*.")) {
      const suffix = alias.slice(2);
      if (candidate === suffix || candidate.endsWith(`.${suffix}`)) return true;
    } else if (candidate === alias) {
      return true;
    }
  }
  return false;
}

export function panelIdentityGuardForIdentity(domain: string, identity: PanelIdentity): void {
  const normalized = normalizeIdentityHostname(domain);
  if (!normalized) failAction(`invalid domain: '${domain}'`);
  if (panelIdentityMatches(normalized, identity)) {
    failAction(`refusing to act on the CloudPanel panel site or alias: '${domain}'`);
  }
}

function panelIdentityGuard(domain: string, identityPath = PANEL_IDENTITY_PATH): void {
  const identity = readPanelIdentity(identityPath);
  if (!identity) failAction("the CloudPanel panel identity is missing or malformed");
  panelIdentityGuardForIdentity(domain, identity);
}

export function validateDomain(value: string, identityPath = PANEL_IDENTITY_PATH, what?: string): string {
  const option = what ? `--${what}` : "--domain";
  if (!value) failAction(`missing ${option}`);
  if (value.length > 253) failAction(what ? `the ${option} domain is too long` : "domain too long");
  let normalized = value.toLowerCase();
  const invalid = () => failAction(what ? `invalid domain for ${option}: '${value}'` : `invalid domain: '${value}'`);
  if (normalized.includes("..")) invalid();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  if (!matchesEntire(HOSTNAME_RE, normalized)) invalid();
  panelIdentityGuard(normalized, identityPath);
  return normalized;
}

function normalizePanelHostname(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.includes("..")) return null;
  if (HOSTNAME_RE.test(host) || WILDCARD_HOSTNAME_RE.test(host)) return host;
  return null;
}

export function panelIdentityFromVhost(content: string): PanelIdentity | null {
  const names = new Set<string>();
  const uncommented = content.replace(/#[^\r\n]*/g, "");
  const directive = /(?:^|[;{}])\s*server_name\s+([^;]+);/gim;
  let match: RegExpExecArray | null;
  let sawDirective = false;
  while ((match = directive.exec(uncommented))) {
    sawDirective = true;
    for (const raw of match[1]!.trim().split(/\s+/)) {
      if (raw === "_" || raw.toLowerCase() === "localhost") continue;
      const name = normalizePanelHostname(raw);
      if (!name) return null;
      names.add(name);
    }
  }

  const exact = [...names].find((name) => HOSTNAME_RE.test(name));
  // A stock CloudPanel serves the panel as `server_name _;` and only gains a
  // hostname once an operator sets one. That is the catch-all panel, not an
  // unparseable vhost: there is no panel domain, so nothing can collide with
  // it, and the guard has nothing to refuse. A vhost with no server_name at
  // all is still rejected -- it is not the file we think it is.
  if (!exact) return sawDirective && names.size === 0 ? { primary: "", aliases: [] } : null;
  return { primary: exact, aliases: [...names].filter((name) => name !== exact).sort() };
}

export function formatPanelIdentity(identity: PanelIdentity): string {
  return "# Managed by clp-addons; read by the root action binary.\n" +
    `PRIMARY=${identity.primary}\n` +
    `ALIASES=${identity.aliases.join(" ")}\n`;
}
