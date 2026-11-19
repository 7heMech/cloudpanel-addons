/**
 * The Panel gate's two Nginx edits: CloudPanel's custom-domain vhost asks for
 * the origin-pull client certificate on 443, and the panel's own server on
 * 8443 answers loopback only. See "Panel gate" in docs/decisions/firewall.md.
 */
import { nginxServers, type NginxBlock } from "../../lib/nginx-config";

const SITES_TAG = "# clp-addons:panel-gate";
const SITES_LINE_RE = /^[ \t]*ssl_(?:client_certificate|verify_client)[ \t][^\n]*# clp-addons:panel-gate\n/gm;
const PANEL_BLOCK_RE = /^[ \t]*# clp-addons:panel-gate:start\n(?:.*\n)*?[ \t]*# clp-addons:panel-gate:end\n/gm;
export const PANEL_GATE_MARKER = /# clp-addons:panel-gate/;

// $remote_addr is X-Forwarded-For's address for the panel's trusted peers, 127.0.0.1 among them.
const PANEL_BLOCK = [
  "  # clp-addons:panel-gate:start",
  '  if ($realip_remote_addr !~ "^(?:127\\.0\\.0\\.1|::1)$") {',
  "    return 444;",
  "  }",
  "  # clp-addons:panel-gate:end",
  "",
].join("\n");

const CERT_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

function servers(content: string): NginxBlock[] | null {
  try { return nginxServers(content); } catch { return null; }
}

const directive = (block: NginxBlock, name: string) => block.directives.filter((entry) => entry.words[0] === name);

export function withoutSitesGate(content: string): string {
  return content.replace(SITES_LINE_RE, "");
}

/**
 * Why the custom-domain vhost cannot take the gate, or null: one server block,
 * for `hostname` alone, on 443 with TLS, and no client certificate of its own.
 */
export function sitesGateMisfit(content: string, hostname: string): string | null {
  const blocks = servers(withoutSitesGate(content));
  if (!blocks) return "CloudPanel's custom-domain vhost could not be read as Nginx configuration";
  if (blocks.length !== 1) return `CloudPanel's custom-domain vhost has ${blocks.length} server blocks, not one`;
  const block = blocks[0]!;
  const names = directive(block, "server_name");
  if (names.length !== 1 || names[0]!.words.length !== 2 || names[0]!.words[1]!.toLowerCase() !== hostname) {
    return `CloudPanel's custom-domain vhost does not serve ${hostname} alone`;
  }
  if (!directive(block, "listen").some((entry) => entry.words.includes("ssl") && /(?:^|:)443$/.test(entry.words[1] ?? ""))) {
    return "CloudPanel's custom-domain vhost does not listen on 443 with TLS";
  }
  if (directive(block, "ssl_verify_client").length || directive(block, "ssl_client_certificate").length) {
    return "CloudPanel's custom-domain vhost already checks client certificates";
  }
  return null;
}

/** The vhost with the two lines after its `server_name`; null when it does not fit. */
export function withSitesGate(content: string, hostname: string, certPath: string): string | null {
  if (!CERT_PATH_RE.test(certPath)) return null;
  const upstream = withoutSitesGate(content);
  if (sitesGateMisfit(upstream, hostname)) return null;
  const name = directive(servers(upstream)![0]!, "server_name")[0]!;
  const lineEnd = upstream.indexOf("\n", name.end);
  const at = lineEnd === -1 ? upstream.length : lineEnd + 1;
  const indent = /^[ \t]*/.exec(upstream.slice(upstream.lastIndexOf("\n", name.start) + 1))![0];
  const lines = `${indent}ssl_client_certificate ${certPath}; ${SITES_TAG}\n${indent}ssl_verify_client on; ${SITES_TAG}\n`;
  return `${upstream.slice(0, at)}${lineEnd === -1 ? "\n" : ""}${lines}${upstream.slice(at)}`;
}

/** Whether the vhost holds the gate's lines for this certificate. */
export function hasSitesGate(content: string, hostname: string, certPath: string): boolean {
  return withSitesGate(content, hostname, certPath) === content;
}

export function withoutPanelGate(content: string): string {
  return content.replace(PANEL_BLOCK_RE, "");
}

function panelServer(content: string): NginxBlock | string {
  const blocks = servers(content);
  if (!blocks) return "the panel's vhost could not be read as Nginx configuration";
  const panel = blocks.filter((block) => directive(block, "listen").some((entry) => /(?:^|:)8443$/.test(entry.words[1] ?? "")));
  if (panel.length !== 1) return `the panel's vhost has ${panel.length} server blocks on 8443, not one`;
  return panel[0]!;
}

export function panelGateMisfit(content: string): string | null {
  const found = panelServer(withoutPanelGate(content));
  return typeof found === "string" ? found : null;
}

/** The panel's vhost with the block first in its 8443 server, before any rewrite there can `break`. */
export function withPanelGate(content: string): string | null {
  const upstream = withoutPanelGate(content);
  const block = panelServer(upstream);
  if (typeof block === "string") return null;
  const lineEnd = upstream.indexOf("\n", block.open);
  const at = lineEnd === -1 ? upstream.length : lineEnd + 1;
  return `${upstream.slice(0, at)}${lineEnd === -1 ? "\n" : ""}${PANEL_BLOCK}${upstream.slice(at)}`;
}

export function hasPanelGate(content: string): boolean {
  return withPanelGate(content) === content;
}
