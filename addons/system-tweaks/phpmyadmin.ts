/**
 * CloudPanel's panel vhost turns basic auth off for any request whose raw
 * `$request_uri` starts with /phpmyadmin, so /phpmyadmin/../file-manager/
 * skipped it. A marked block before its `auth_basic $basicAuth;` turns basic
 * auth back on unless the decoded, normalized `$uri` is phpMyAdmin's, and
 * answers 404 for phpMyAdmin's example and setup scripts and the files that
 * give its version away. The panel signs in through /phpmyadmin/login.php,
 * which stays served.
 */
import { errorMessage } from "../../lib/errors";
import { readFileSync } from "node:fs";
import { failAction } from "../../lib/action";
import { runCommand, type CommandResult } from "../../lib/command";
import { nginxFileChange, trustedVhost, withNginxTransaction } from "../../lib/nginx-transaction";
import { ROOT_UID, nginxLayout } from "../../lib/paths";
import { panelUserGid, panelUserUid } from "../../lib/sso-auth";
import { COMMAND_MS, REAL_IP_GATEWAY_TIMEOUT_MS } from "./limits";
import { applyThenSave, tweak } from "./tweak";
import { badge, statusLine, switchRow } from "./app/rows";
import { esc } from "../../lib/app-http";

// The /addons/ proxy's baseline in cli/inject.ts leaves this block out with withoutPhpMyAdminRules.
const BLOCK_RE = /^[ \t]*# clp-addons:phpmyadmin:start\n(?:.*\n)*?[ \t]*# clp-addons:phpmyadmin:end\n/gm;
const AUTH_RE = /^[ \t]*auth_basic[ \t]+\$basicAuth[ \t]*;/gm;
const USER_FILE_RE = /^[ \t]*auth_basic_user_file[ \t]+(\/[A-Za-z0-9._/-]+)[ \t]*;/gm;

/** Directories phpMyAdmin's pages never load from the browser. */
const HIDDEN_DIRS = ["examples", "setup", "sql", "vendor", "libraries", "templates", "locale", "tmp"];
const HIDDEN_FILES = String.raw`\.|ChangeLog$|README$|LICENSE$|RELEASE-DATE-|CONTRIBUTING\.md$|composer\.(?:json|lock)$|package\.json$|yarn\.lock$|babel\.config\.json$|config\.sample\.inc\.php$`;

function phpMyAdminBlock(credentials: string): string {
  return [
    "  # clp-addons:phpmyadmin:start",
    `  set $clp_addons_auth "";`,
    `  if (-f ${credentials}) {`,
    `    set $clp_addons_auth "on";`,
    "  }",
    `  if ($uri ~ "^/phpmyadmin(?:/|$)") {`,
    `    set $clp_addons_auth "";`,
    "  }",
    "  if ($clp_addons_auth) {",
    `    set $basicAuth "on";`,
    "  }",
    `  location ~ "^/phpmyadmin/(?:${HIDDEN_DIRS.join("|")})(?:/|$)" {`,
    "    return 404;",
    "  }",
    `  location ~ "^/phpmyadmin/(?:${HIDDEN_FILES})" {`,
    "    return 404;",
    "  }",
    "  # clp-addons:phpmyadmin:end",
    "",
  ].join("\n");
}

export function withoutPhpMyAdminRules(content: string): string {
  return content.replace(BLOCK_RE, "");
}

/** The vhost with the block just before its one `auth_basic $basicAuth;`; null when that line or the credentials path is not there once. */
export function withPhpMyAdminRules(content: string): string | null {
  const upstream = withoutPhpMyAdminRules(content);
  const auth = [...upstream.matchAll(AUTH_RE)];
  const files = [...upstream.matchAll(USER_FILE_RE)];
  if (auth.length !== 1 || files.length !== 1) return null;
  const at = auth[0]!.index!;
  return `${upstream.slice(0, at)}${phpMyAdminBlock(files[0]![1]!)}${upstream.slice(at)}`;
}

const DEFAULT_PHPMYADMIN_PATHS = {
  /** Null takes CloudPanel's own panel vhost, as cli/inject.ts finds it. */
  vhost: null as string | null,
  /** Null takes the panel's own nginx.conf when it has one, as CloudPanel 6 does. */
  panelConf: null as string | null,
  panelUid: null as number | null,
  panelGid: null as number | null,
  nginx: "nginx",
  systemctl: "systemctl",
  rootUid: ROOT_UID,
  rootGid: 0,
};

export interface PhpMyAdminOptions {
  paths?: Partial<typeof DEFAULT_PHPMYADMIN_PATHS>;
  run?: (command: string, args: string[]) => CommandResult;
}

export interface PhpMyAdminStatus {
  /** Whether the vhost holds the current block. */
  active: boolean;
  /** Why the vhost could not be read or changed. */
  problem: string;
}

function target(options: PhpMyAdminOptions) {
  const paths = { ...DEFAULT_PHPMYADMIN_PATHS, ...options.paths };
  const layout = nginxLayout();
  const config = paths.panelConf ?? layout.configFile ?? undefined;
  // The panel's vhost can belong to its account or root, retaining CloudPanel's mode 770.
  const owned = config !== undefined;
  const panelGid = paths.panelGid ?? panelUserGid();
  return {
    paths,
    vhost: paths.vhost ?? `${layout.sitesDir}/cloudpanel.conf`,
    uid: owned ? [paths.panelUid ?? panelUserUid() ?? paths.rootUid, paths.rootUid] as const : paths.rootUid,
    groupWritable: owned ? [paths.rootGid, ...(panelGid === null ? [] : [panelGid])] : false,
    nginx: { nginx: paths.nginx, systemctl: paths.systemctl, config, service: config ? "clp-nginx" : "nginx" },
  };
}

const NO_ANCHOR = "the panel vhost has no single auth_basic $basicAuth; and auth_basic_user_file line to put the phpMyAdmin rules before";

export function phpMyAdminStatus(options: PhpMyAdminOptions = {}): PhpMyAdminStatus {
  const { vhost, uid, groupWritable } = target(options);
  try {
    const { content } = trustedVhost(vhost, uid, groupWritable);
    const wanted = withPhpMyAdminRules(content);
    if (wanted === null) return { active: false, problem: NO_ANCHOR };
    return { active: wanted === content, problem: "" };
  } catch (error) {
    return { active: false, problem: errorMessage(error) };
  }
}

export function applyPhpMyAdmin(enabled: boolean, options: PhpMyAdminOptions = {}): boolean {
  const { vhost, uid, groupWritable, nginx } = target(options);
  let current: string;
  try { current = readFileSync(vhost, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const wanted = (content: string) => {
    if (!enabled) return withoutPhpMyAdminRules(content);
    return withPhpMyAdminRules(content) ?? failAction(NO_ANCHOR);
  };
  if (wanted(current) === current) return false;
  const run = options.run ?? ((command, args) => runCommand(command, args, COMMAND_MS));
  return withNginxTransaction(null, nginx, run, (changes) => {
    const change = nginxFileChange(vhost, null, uid, groupWritable);
    if (change.backup.content === null) return;
    change.content = wanted(change.backup.content);
    changes.push(change);
  }).changed;
}

type PhpMyAdminState = PhpMyAdminStatus & { enabled: boolean };

function phpMyAdminLine(state: PhpMyAdminState): string {
  if (state.problem) return `${badge("Unknown", "warn")} <span>${esc(state.problem)}</span>`;
  if (state.active) return `${badge("On", "ok")} <span>Basic auth covers every panel URL outside phpMyAdmin.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>phpMyAdmin's example sign-on script lets anyone make this server try MySQL logins on other hosts.</span>`;
}

/** Keep basic auth outside phpMyAdmin and hide its example, setup and version files. */
export const PHPMYADMIN_TWEAK = tweak<{ protectPhpMyAdmin: boolean }, { phpMyAdmin?: PhpMyAdminOptions }, { phpMyAdmin: PhpMyAdminState }>()({
  defaults: { protectPhpMyAdmin: true },
  state: ({ options, settings }) => ({ phpMyAdmin: { ...phpMyAdminStatus(options.phpMyAdmin), enabled: settings.protectPhpMyAdmin } }),
  switch: {
    verb: "set-phpmyadmin",
    key: "protectPhpMyAdmin",
    timeout: REAL_IP_GATEWAY_TIMEOUT_MS,
    set: applyThenSave("protectPhpMyAdmin", (on, options: { phpMyAdmin?: PhpMyAdminOptions }) => applyPhpMyAdmin(on, options.phpMyAdmin)),
  },
  repair: {
    // Also the fast repair's, when CloudPanel rewrites its vhost.
    rules: {
      label: "phpMyAdmin rules",
      locked: true,
      run: ({ options, settings }) => settings.protectPhpMyAdmin && applyPhpMyAdmin(true, options.phpMyAdmin) ? "phpMyAdmin rules put back" : null,
    },
  },
  withdraw: { run: ({ options }) => { applyPhpMyAdmin(false, options.phpMyAdmin); } },
  restore: { run: ({ options, settings }) => { if (settings.protectPhpMyAdmin) applyPhpMyAdmin(true, options.phpMyAdmin); } },
  row: ({ phpMyAdmin }, locked) => switchRow("set-phpmyadmin", {
    key: "protectPhpMyAdmin",
    title: "Lock down phpMyAdmin",
    description: [
      "Keeps the panel's basic auth on URLs that only start with /phpmyadmin, such as /phpmyadmin/../file-manager/.",
      "Hides phpMyAdmin's example and setup scripts and the files that show its version. Signing in from the panel still works.",
    ],
    checked: phpMyAdmin.enabled,
    extra: statusLine(phpMyAdminLine(phpMyAdmin)),
  }, locked),
});
