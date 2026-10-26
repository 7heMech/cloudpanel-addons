import CLIENT_JS from "./views.client.js" with { type: "text" };
import STYLE from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { KeyView, Settings, UserKeysView } from "./service";

export function layout(title: string, content: string, updateNotice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, {
    brand: "Security Keys",
    base: mountPath("security-keys"),
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
  });
}

const DAY_MS = 86_400_000;
/** A key unused this long, or never, is one an administrator should look at. */
const STALE_DAYS = 90;

function added(iso: string): string {
  return `<time datetime="${esc(iso)}">${esc(iso.slice(0, 10))}</time>`;
}

function lastUsed(iso: string | null, now: number): string {
  if (!iso) return "Never used";
  // Calendar days in UTC, the zone the exact time on hover is given in.
  const days = Math.floor(now / DAY_MS) - Math.floor(Date.parse(iso) / DAY_MS);
  const text = days < 1 ? "Today" : days === 1 ? "Yesterday" : days < 60 ? `${days} days ago` : `${Math.round(days / 30)} months ago`;
  return `<time datetime="${esc(iso)}" title="${esc(iso.slice(0, 16).replace("T", " "))} UTC">${text}</time>`;
}

function stale(key: KeyView, now: number): boolean {
  return !key.lastUsedAt || now - Date.parse(key.lastUsedAt) > STALE_DAYS * DAY_MS;
}

const ROLE_NAMES: Record<string, string> = { ROLE_ADMIN: "Administrator", ROLE_SITE_MANAGER: "Site manager", ROLE_USER: "User" };

const ROLE_LABELS: [Settings["roles"][number], string][] = [
  ["ROLE_ADMIN", "Administrators"],
  ["ROLE_SITE_MANAGER", "Site managers"],
  ["ROLE_USER", "Users"],
];

/** Until anyone has a key: the steps from an empty list to a key that signs in. */
function setupCard(): string {
  const step = (id: string, title: string, hint: string) =>
    `<li${id ? ` id="${id}"` : ""}><div><strong>${title}</strong><span class="hint">${hint}</span></div></li>`;
  return `
    <div class="card sk-setup">
      <h2>Set up security keys</h2>
      <ol class="sk-checklist">
        ${step("sk-step-address", "Open the panel on its hostname", "Browsers refuse security keys on an IP address or a certificate error, so use the domain with a valid certificate.")}
        ${step("", 'Add your own key under <a href="/security">Account → Security</a>', "Every panel user adds their own there; this page lists them all.")}
        ${step("", "Sign out and choose Sign in with a security key", "The key asks for its PIN, a fingerprint or the device's unlock. Your password keeps working.")}
      </ol>
    </div>`;
}

function settingsCard(settings: Settings, users: UserKeysView[]): string {
  // An account that no longer signs in is refused whatever its role, so its keys count for none.
  const tile = ([role, label]: (typeof ROLE_LABELS)[number]) => {
    const on = settings.roles.includes(role);
    const count = users.filter((entry) => entry.active && entry.role === role).reduce((total, entry) => total + entry.keys.length, 0);
    const keys = `${count} key${count === 1 ? "" : "s"}`;
    const note = count === 0 ? '<span class="hint">No keys</span>'
      : on ? `<span class="hint">${keys}</span>` : `<span class="sk-refused">${keys} refused</span>`;
    return `
          <label class="sk-tile"><input id="role-${role}" type="checkbox" ${on ? "checked" : ""} onchange="saveSettings(this)"><strong>${label}</strong>${note}</label>`;
  };
  const synced = users.reduce((total, entry) => total + entry.keys.filter((key) => key.synced).length, 0);
  const warning = settings.roles.length === 0
    ? "Every role is off, so nobody can add a key or sign in with one."
    : !settings.syncedPasskeys && synced
      ? `${synced} synced passkey${synced === 1 ? " is" : "s are"} on file and refused while this is off.`
      : "";
  return `
    <div class="card settings-card">
      <div class="card-header"><h2>Settings</h2></div>
      ${warning ? `<div class="notice">${warning}</div>` : ""}
      <div class="sk-setting">
        <h3>Who can use security keys</h3>
        <p class="hint">Accounts in a role that is off keep their keys and their password, but cannot add or use a key.</p>
        <div class="sk-tiles">${ROLE_LABELS.map(tile).join("")}
        </div>
      </div>
      <div class="sk-setting sk-switch-row">
        <h3>Accept synced passkeys</h3>
        <p class="hint">Passkeys a password manager or your devices copy between them, such as Bitwarden, iCloud Keychain or Google Password Manager. Off, only hardware keys and passkeys that stay on one device are accepted.</p>
        <label class="switch"><input id="synced-passkeys" type="checkbox" aria-label="Accept synced passkeys" ${settings.syncedPasskeys ? "checked" : ""} onchange="saveSettings(this)"><span></span></label>
      </div>
    </div>`;
}

/** Why an account's keys cannot sign in, or "" when they can. */
function blocked(entry: UserKeysView, settings: Settings): string {
  if (!entry.active) return "No longer signs in";
  if (!(settings.roles as string[]).includes(entry.role ?? "")) return "Role is off";
  return "";
}

function userGroup(entry: UserKeysView, settings: Settings, now: number): string {
  const count = `${entry.keys.length} key${entry.keys.length === 1 ? "" : "s"}`;
  const about = entry.active ? `${ROLE_NAMES[entry.role ?? ""] ?? "Panel user"} · ${count}` : count;
  const why = blocked(entry, settings);
  return `
          <tbody class="sk-group">
            <tr class="sk-group-head"><th colspan="4" scope="rowgroup"><strong>${esc(entry.user)}</strong> <span class="hint">${about}</span>${why ? ` <span class="sk-refused">${why}</span>` : ""}</th></tr>${entry.keys.map((key) => {
    const refused = key.synced && !settings.syncedPasskeys;
    const host = new URL(key.origin).host;
    return `
            <tr class="sk-key${stale(key, now) ? " is-stale" : ""}" data-find="${esc(`${entry.user} ${key.name}`.toLowerCase())}"${key.synced ? " data-synced" : ""}${why || refused ? " data-blocked" : ""}>
              <td class="sk-name"><span>${esc(key.name)}</span>${refused
                ? '<span class="sk-refused">Synced passkey, not accepted</span>'
                : key.synced ? '<span class="hint">Synced passkey</span>' : ""}<span class="hint sk-host" data-host="${esc(host)}" hidden>Added on <span class="mono">${esc(host)}</span></span></td>
              <td class="sk-added">${added(key.createdAt)}</td>
              <td class="sk-used">${lastUsed(key.lastUsedAt, now)}</td>
              <td class="action-cell"><button class="btn btn-danger" type="button" data-user="${esc(entry.user)}" data-id="${esc(key.id)}" data-name="${esc(key.name)}" onclick="revokeKey(this)">Remove</button></td>
            </tr>`;
  }).join("")}
          </tbody>`;
}

export function dashboardView({ users, settings }: { users: UserKeysView[]; settings: Settings }, now = Date.now()): string {
  const owners = users.filter((entry) => entry.keys.length > 0);
  const count = owners.reduce((total, entry) => total + entry.keys.length, 0);
  const summary = `${count} key${count === 1 ? "" : "s"} for ${owners.length} user${owners.length === 1 ? "" : "s"}`;

  return `
    <div class="page-heading">
      <div><h1>Security Keys</h1><p>Passkeys and hardware keys that sign in to CloudPanel without a password.</p></div>
    </div>
    ${count === 0 ? setupCard() : `
    <div class="card card-table">
      <div class="sk-toolbar">
        <input type="search" id="sk-find" placeholder="Find a user or key" aria-label="Find a user or key" oninput="filterKeys()">
        <select id="sk-show" aria-label="Show" onchange="filterKeys()">
          <option value="all">All keys</option>
          <option value="stale">Not used in ${STALE_DAYS} days</option>
          <option value="synced">Synced passkeys</option>
          <option value="blocked">Keys that cannot sign in</option>
        </select>
        <span class="hint" id="sk-summary" data-all="${esc(summary)}">${esc(summary)}</span>
      </div>
      <table class="sk-table">
        <thead><tr><th scope="col">Key</th><th scope="col">Added</th><th scope="col">Last used</th><th scope="col" class="action-cell"></th></tr></thead>${owners.map((entry) => userGroup(entry, settings, now)).join("")}
      </table>
      <div class="empty" id="sk-none" hidden>No key matches.</div>
    </div>`}
    ${settingsCard(settings, owners)}`;
}
