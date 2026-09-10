// Read-only reconnaissance dump for a CloudPanel box under investigation.
// Ported from the historical tools/recon.sh so operators can scp the single
// compiled binary onto an uninvestigated panel (which may have no Bun
// installed) and run `clp-addons recon`. Deliberately absent from usage()
// and --help: this is a diagnostic for whoever is investigating a panel, not
// a command an end user should reach for.
//
// STRICTLY READ-ONLY. Every probe below only reads: it creates no files or
// directories, starts nothing, installs nothing, and never touches the
// panel's credential/user columns. Every sqlite read goes through
// `sqlite3 -readonly`. Skim before sharing: it can surface path layouts and
// config detail that shouldn't leave the box carelessly.

import { existsSync } from "node:fs";
import { PANEL_DB } from "./paths";

/**
 * Run a shell snippet via `sh -c` and return its captured stdout as text.
 * Any stderr redirection (merging into stdout, or discarding) is expected to
 * already be embedded in `cmd` itself, exactly as the original bash script
 * wrote it; unredirected stderr is inherited straight to this process's
 * stderr, matching what an un-redirected command would do under bash.
 */
async function sh(cmd: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", cmd], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

/** Mirrors `sed 's/^/    /'`: prefix every line of output with 4 spaces. */
function indent(text: string): string {
  if (text === "") return "";
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return body.split("\n").map((line) => `    ${line}`).join("\n") + "\n";
}

/** Mirrors `hr()`: a blank line, a "=== TITLE" header padded with 50 '='. */
function hr(title: string): string {
  return `\n=== ${title} ${"=".repeat(50)}\n`;
}

/** Mirrors `note()`: a blank line then an un-indented "[note] ..." line. */
function note(text: string): string {
  return `\n[note] ${text}\n`;
}

/** Mirrors `q()`: run a command with stdout+stderr merged, indented output. */
async function q(cmdLine: string): Promise<string> {
  const out = await sh(`${cmdLine} 2>&1`);
  return `\n--- $ ${cmdLine}\n${indent(out)}`;
}

/** Mirrors `sq()`: run a read-only sqlite3 query, header + indented output. */
async function sq(query: string): Promise<string> {
  const escaped = query.replace(/'/g, `'\\''`);
  const out = await sh(`sqlite3 -readonly "${PANEL_DB}" '${escaped}' 2>&1`);
  return `\n--- sqlite: ${query}\n${indent(out)}`;
}

/** For hand-rolled blocks: a literal header followed by indented output. */
async function block(header: string, cmd: string): Promise<string> {
  return header + indent(await sh(cmd));
}

export async function runRecon(): Promise<void> {
  const out = (s: string) => process.stdout.write(s);

  const date = (await sh("date -Is")).trimEnd();
  const host = (await sh("hostname")).trimEnd();
  out(`cloudpanel-addons recon\ndate: ${date}\nhost: ${host}\n`);
  if (process.getuid?.() !== 0) out(note("not running as root; several probes will be incomplete"));

  out(hr("1. HOST AND BUN COMPILE TARGET"));
  out(await q("uname -srm"));
  out(await q("cat /etc/os-release"));
  out(await block("\n--- $ ldd --version | head -1\n", "ldd --version 2>&1 | head -1"));
  out(await block(
    "\n--- cpu flags of interest\n",
    "lscpu 2>/dev/null | tr ',' '\\n' | tr ' ' '\\n' | grep -ixE 'avx|avx2|avx512f|sse4_2' | sort -u",
  ));
  out(note("no avx2 in that list means you need the baseline bun target"));
  out(await q("nproc"));
  out(await q("free -m"));
  out(await block("\n--- $ df -h / /home /var/lib/docker\n", "df -h / /home /var/lib/docker 2>&1"));

  out(hr("2. RUNTIMES AND TOOLING"));
  for (const c of ["sqlite3", "docker", "bun", "node", "php", "nginx", "openssl", "flock", "curl", "jq"]) {
    const resolved = Bun.which(c) ?? "MISSING";
    out(`    ${c.padEnd(9)} ${resolved}\n`);
  }
  out(await q("docker --version"));
  out(await block("\n--- $ systemctl is-active docker\n", "systemctl is-active docker 2>&1"));
  out(await block("\n--- $ docker compose version\n", "docker compose version 2>&1 | head -3"));
  out(note("docker missing means decide native Bun per site user instead"));

  out(hr("3. CLOUDPANEL VERSION AND UPDATE MECHANISM"));
  out(await q("clpctl --version"));
  out(await block("\n--- $ dpkg -l | grep -i clp\n", "dpkg -l 2>/dev/null | grep -i 'clp\\|cloudpanel'"));
  out("\n--- clp-update\n");
  for (const p of ["/usr/bin/clp-update", "/usr/local/bin/clp-update"]) {
    if (existsSync(p)) {
      out(indent(await sh(`ls -la "${p}"`)));
      out(indent(await sh(`file "${p}"`)));
    }
  }
  out(await block("\n--- $ ls /etc/apt/sources.list.d/\n", "ls -la /etc/apt/sources.list.d/ 2>&1"));
  out(await block(
    "\n--- unattended-upgrades enabled?\n",
    "grep -rhs 'Unattended-Upgrade\\|Update-Package-Lists' /etc/apt/apt.conf.d/ 2>/dev/null",
  ));
  out(await block(
    "\n--- cron entries mentioning clp or vhost-templates\n",
    "grep -rhs 'clp\\|vhost-template' /etc/cron.d /etc/crontab /etc/cron.daily /var/spool/cron 2>/dev/null",
  ));
  out(note("a vhost-templates:import cron entry here is the gating question"));

  out(hr("4. PANEL FILESYSTEM LAYOUT"));
  out(await q("ls -la /home/clp/htdocs/"));
  out(await q("ls -la /home/clp/htdocs/app/"));
  out(await block(
    "\n--- template and view directories\n",
    "find /home/clp/htdocs -maxdepth 5 -type d \\( -name 'templates' -o -name 'views' -o -name 'Resources' \\) 2>/dev/null",
  ));
  const twigCount = (await sh("find /home/clp/htdocs -name '*.twig' 2>/dev/null | wc -l")).trim();
  out(`\n--- twig file count\n    ${twigCount} twig files\n`);
  out(await block(
    "\n--- twig files mentioning site creation or site types\n",
    "grep -rls --include='*.twig' -iE 'reverse.?proxy|wordpress|site.?type' /home/clp/htdocs 2>/dev/null | head -20",
  ));
  out(await block(
    "\n--- twig files mentioning the sidebar or nav\n",
    "grep -rls --include='*.twig' -iE 'sidebar|nav|menu' /home/clp/htdocs 2>/dev/null | head -20",
  ));
  out(await block(
    "\n--- candidate cache directories\n",
    "find /home/clp/htdocs -maxdepth 5 -type d \\( -name 'cache' -o -name 'var' -o -name 'twig' \\) 2>/dev/null",
  ));
  out(`\n--- ownership of the panel tree, top two levels\n${await sh(
    "find /home/clp/htdocs -maxdepth 2 -printf '    %M %u:%g %p\\n' 2>/dev/null | head -30",
  )}`);

  out(hr("5. PANEL DATABASE, SCHEMA ONLY"));
  out(await q(`ls -la ${PANEL_DB}`));
  out(await block("\n--- $ sqlite3 --version\n", "sqlite3 --version 2>&1"));
  out(await sq(".tables"));
  out(await sq(".schema site"));
  out(await sq(".schema php_settings"));
  out(await block(
    "\n--- schema lines mentioning a port\n",
    `sqlite3 -readonly "${PANEL_DB}" '.schema' 2>&1 | grep -i port`,
  ));
  out(await block(
    "\n--- schema lines mentioning a template\n",
    `sqlite3 -readonly "${PANEL_DB}" '.schema' 2>&1 | grep -i 'template'`,
  ));
  out(await sq("SELECT type, COUNT(*) FROM site GROUP BY type;"));
  out(await sq("SELECT id, domain_name, type FROM site ORDER BY id;"));
  out(note("site.type values above are the closed set we must not add to"));
  out(note("NEVER run clpctl db:show:master-credentials, and never SELECT from the user table"));

  out(hr("6. VHOST TEMPLATES"));
  out(await q("clpctl vhost-template:list"));
  out(await block(
    "\n--- on-disk vhost template locations\n",
    "find / -maxdepth 6 -type d -name '*vhost-template*' 2>/dev/null",
  ));
  out(note("upsert vs truncate is destructive; snapshot the box before testing it"));

  out(hr("7. NGINX AND THE PANEL LISTENER"));
  out(await q("nginx -v"));
  out(await block("\n--- $ ls /etc/nginx/sites-enabled/\n", "ls -la /etc/nginx/sites-enabled/ 2>&1"));
  out(await block("\n--- $ ls /etc/nginx/sites-available/\n", "ls -la /etc/nginx/sites-available/ 2>&1"));
  out(await block("\n--- files referencing the panel port 8443\n", "grep -rls '8443' /etc/nginx/ 2>/dev/null"));
  out(await block(
    "\n--- proxy_pass lines already present\n",
    "grep -rhs 'proxy_pass' /etc/nginx/sites-enabled/ 2>/dev/null | sort -u",
  ));
  out(await block("\n--- nginx config test\n", "nginx -t 2>&1"));

  out(hr("8. PORTS IN USE AND FIREWALL"));
  out(await block("\n--- listening sockets\n", "ss -tlnp 2>/dev/null"));
  out("\n--- anything already in 39000-39999\n");
  out(await sh("ss -tln 2>/dev/null | grep -E ':(39[0-9]{3})' | sed 's/^/    /' || printf '    none\\n'"));
  out(await block("\n--- $ ufw status\n", "ufw status 2>&1"));
  out(await block(
    "\n--- docker published ports\n",
    "docker ps --format '    {{.Names}}  {{.Ports}}' 2>/dev/null",
  ));
  out(note("any 0.0.0.0 binding above is the ufw bypass decision 2.9 warns about"));

  out(hr("9. SUDO AND USER MODEL"));
  out(await q("ls -la /etc/sudoers.d/"));
  out(await block("\n--- sudoers.d contents\n", "grep -rhs '' /etc/sudoers.d/ 2>/dev/null"));
  out(await block("\n--- $ visudo -c\n", "visudo -c 2>&1"));
  out(await block("\n--- clp user\n", "id clp 2>&1"));
  out(`\n--- site users present\n${await sh(
    "awk -F: '$3>=1000 && $3<65000 {printf \"    %s uid=%s home=%s shell=%s\\n\",$1,$3,$6,$7}' /etc/passwd",
  )}`);

  out(hr("10. SYSTEMD AND EXISTING UNITS"));
  out(await block(
    "\n--- units mentioning clp, node, bun or instatic\n",
    "systemctl list-units --all --no-pager --no-legend 2>/dev/null | grep -iE 'clp|node|bun|instatic'",
  ));
  out(await block(
    "\n--- timers\n",
    "systemctl list-timers --all --no-pager --no-legend 2>/dev/null",
  ));

  out(hr("END"));
  out("\nSkim this file for anything sensitive before sharing it.\n");
}
