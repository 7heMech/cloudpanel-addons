// The plugins CloudPanel's New WordPress Site form starts with: the server's,
// which an administrator sets on the WordPress Tools page, or an account's own,
// saved from the form. WordPress.org plugins only: a zip is chosen per site.
//
// Accounts are a list rather than an object keyed by name, since a panel user
// name may be `__proto__`.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";
import { MAX_NEW_SITE_PLUGINS } from "./new-site-plugins";
import { DIRECTORY_SLUG_RE, cleanLabel } from "./plugin-zip";

export interface DefaultPlugin {
  slug: string;
  name: string;
  activate: boolean;
}

export interface PluginDefaults {
  server: DefaultPlugin[];
  /** Accounts with a default of their own, which may be empty; any other follows the server's. */
  accounts: { user: string; plugins: DefaultPlugin[] }[];
}

const MAX_NAME = 120;

/** A default list as a browser or the state file gives it; throws saying what is wrong. */
export function defaultPluginList(value: unknown): DefaultPlugin[] {
  if (!Array.isArray(value)) throw new Error("the default plugins must be a list");
  if (value.length > MAX_NEW_SITE_PLUGINS) throw new Error(`a default holds at most ${MAX_NEW_SITE_PLUGINS} plugins`);
  const plugins = value.map((item: unknown) => {
    const entry = item as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || typeof entry.slug !== "string" || !DIRECTORY_SLUG_RE.test(entry.slug)) {
      throw new Error("that is not a WordPress.org plugin slug");
    }
    if (typeof entry.activate !== "boolean") throw new Error("activate must be true or false");
    const name = typeof entry.name === "string" ? cleanLabel(entry.name).slice(0, MAX_NAME) : "";
    return { slug: entry.slug, name: name || entry.slug, activate: entry.activate };
  });
  if (new Set(plugins.map((plugin) => plugin.slug)).size !== plugins.length) throw new Error("the same plugin is in the default twice");
  return plugins;
}

/** Empty when nothing was saved yet; throws when the file cannot be read as one. */
export function readPluginDefaults(path: string): PluginDefaults {
  if (!existsSync(path)) return { server: [], accounts: [] };
  const state = JSON.parse(readFileSync(path, "utf8")) as Partial<PluginDefaults>;
  if (!Array.isArray(state.accounts)) throw new Error("the default plugins are invalid");
  const accounts = state.accounts.map((entry) => {
    if (!entry || typeof entry.user !== "string") throw new Error("the default plugins are invalid");
    return { user: entry.user, plugins: defaultPluginList(entry.plugins) };
  });
  return { server: defaultPluginList(state.server), accounts };
}

export function savePluginDefaults(path: string, state: PluginDefaults): void {
  writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600, createParent: true });
}

/** The account's own default, or null when it follows the server's. */
export function accountDefault(state: PluginDefaults, user: string): DefaultPlugin[] | null {
  return state.accounts.find((entry) => entry.user === user)?.plugins ?? null;
}

/** With the account's own default replaced, or removed when `plugins` is null. */
export function withAccountDefault(state: PluginDefaults, user: string, plugins: DefaultPlugin[] | null): PluginDefaults {
  const others = state.accounts.filter((entry) => entry.user !== user);
  return { server: state.server, accounts: plugins ? [...others, { user, plugins }] : others };
}
