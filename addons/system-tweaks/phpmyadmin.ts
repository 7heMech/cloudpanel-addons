/**
 * CloudPanel's panel vhost turns basic auth off for any request whose raw
 * `$request_uri` starts with /phpmyadmin, so /phpmyadmin/../file-manager/
 * skipped it. A marked block before its `auth_basic $basicAuth;` turns basic
 * auth back on unless the decoded, normalized `$uri` is phpMyAdmin's, and
 * answers 404 for phpMyAdmin's example and setup scripts and the files that
 * give its version away. The panel signs in through /phpmyadmin/login.php,
 * which stays served.
 */
import { readFileSync } from "node:fs";
import { failAction } from "../../lib/action";
import { runCommand, type CommandResult } from "../../lib/command";
import { nginxFileChange, trustedVhost, withNginxTransaction } from "../../lib/nginx-transaction";
import { ROOT_UID, nginxLayout } from "../../lib/paths";
import { panelUserGid, panelUserUid } from "../../lib/sso-auth";
import { COMMAND_MS } from "./limits";

// The /addons/ proxy's baseline in cli/inject.ts leaves this block out with withoutPhpMyAdminRules.
const BLOCK_RE = /^[ \t]*# clp-addons:phpmyadmin:start\n(?:.*\n)*?[ \t]*# clp-addons:phpmyadmin:end\n/gm;
const AUTH_RE = /^[ \t]*auth_basic[ \t]+\$basicAuth[ \t]*;/gm;
const USER_FILE_RE = /^[ \t]*auth_basic_user_file[ \t]+(\/[A-Za-z0-9._/-]+)[ \t]*;/gm;

/** Directories phpMyAdmin's pages never load from the browser. */
const HIDDEN_DIRS = ["examples", "setup", "sql", "vendor", "libraries", "templates", "locale", "tmp"];
/** Release and package files, dotfiles, and the sample config. */
const HIDDEN_FILES = String.raw`\.|ChangeLog$|README$|LICENSE$|RELEASE-DATE-|CONTRIBUTING\.md$|composer\.(?:json|lock)$|package\.json$|yarn\.lock$|babel\.config\.json$|config\.sample\.inc\.php$`;

export function phpMyAdminBlock(credentials: string): string {
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

export const DEFAULT_PHPMYADMIN_PATHS = {
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
    return { active: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Adds or removes the block, testing and reloading the panel's Nginx and restoring the file on failure. */
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
