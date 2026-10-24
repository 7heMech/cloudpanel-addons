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

function settingsCard(settings: Settings): string {
  const switchRow = (id: string, label: string, hint: string, checked: boolean) => `
        <div class="setting-row">
          <div><label for="${id}">${label}</label>${hint ? `<p class="hint">${hint}</p>` : ""}</div>
          <label class="switch"><input id="${id}" type="checkbox" ${checked ? "checked" : ""} onchange="saveSettings(this)"><span></span></label>
        </div>`;
  return `
    <div class="card settings-card">
      <div>
        <h2>Who can use security keys</h2>
        <p>Accounts in a role that is off cannot add keys or sign in with them. Their keys are kept, and their password still works.</p>
        ${ROLE_LABELS.map(([role, label]) => switchRow(`role-${role}`, label, "", settings.roles.includes(role))).join("")}
      </div>
      <div>
        <h2>Synced passkeys</h2>
        <p>Passkeys a password manager or your devices copy between them, such as Bitwarden, iCloud Keychain or Google Password Manager. Off, only hardware keys and passkeys that stay on one device are accepted.</p>
        ${switchRow("synced-passkeys", "Accept synced passkeys", "", settings.syncedPasskeys)}
      </div>
    </div>`;
}

function keyType(key: KeyView, settings: Settings): string {
  if (!key.synced) return '<span class="hint">Device-bound</span>';
  return settings.syncedPasskeys
    ? '<span class="hint">Synced passkey</span>'
    : '<span class="sk-refused">Synced passkey, not accepted</span>';
}

function userGroup(entry: UserKeysView, settings: Settings, now: number): string {
  const count = `${entry.keys.length} key${entry.keys.length === 1 ? "" : "s"}`;
  const about = entry.active ? `${ROLE_NAMES[entry.role ?? ""] ?? "Panel user"} · ${count}` : count;
  return `
          <tbody class="sk-group"${entry.active ? "" : " data-inactive"}>
            <tr class="sk-group-head"><th colspan="5" scope="rowgroup"><strong>${esc(entry.user)}</strong> <span class="hint">${about}</span>${entry.active ? "" : ' <span class="sk-refused">No longer signs in</span>'}</th></tr>${entry.keys.map((key) => `
            <tr class="sk-key${stale(key, now) ? " is-stale" : ""}" data-find="${esc(`${entry.user} ${key.name}`.toLowerCase())}"${key.synced ? " data-synced" : ""}>
              <td class="sk-name"><span>${esc(key.name)}</span>${keyType(key, settings)}</td>
              <td class="mono sk-host" data-host="${esc(new URL(key.origin).host)}">${esc(new URL(key.origin).host)}</td>
              <td>${added(key.createdAt)}</td>
              <td class="sk-used">${lastUsed(key.lastUsedAt, now)}</td>
              <td class="action-cell"><button class="btn btn-danger" type="button" data-user="${esc(entry.user)}" data-id="${esc(key.id)}" data-name="${esc(key.name)}" onclick="revokeKey(this)">Remove</button></td>
            </tr>`).join("")}
          </tbody>`;
}

export function dashboardView({ users, settings }: { users: UserKeysView[]; settings: Settings }, now = Date.now()): string {
  const owners = users.filter((entry) => entry.keys.length > 0);
  const count = owners.reduce((total, entry) => total + entry.keys.length, 0);
  const summary = `${count} key${count === 1 ? "" : "s"} for ${owners.length} user${owners.length === 1 ? "" : "s"}`;

  return `
    <div class="page-heading">
      <div><h1>Security Keys</h1><p>Passkeys and hardware keys that sign in to CloudPanel without a password. Each user adds their own under <a href="/security">Account → Security</a>.</p></div>
    </div>
    <div class="notice" id="sk-address" hidden>This panel is open on an IP address. Security keys work only on a hostname with a valid certificate, so open the panel on its domain to add or use one.</div>
    ${settingsCard(settings)}
    <div class="card card-table">
      ${count === 0
        ? '<div class="empty">No security keys yet.</div>'
        : `<div class="sk-toolbar">
            <input type="search" id="sk-find" placeholder="Find a user or key" aria-label="Find a user or key" oninput="filterKeys()">
            <select id="sk-show" aria-label="Show" onchange="filterKeys()">
              <option value="all">All keys</option>
              <option value="stale">Not used in ${STALE_DAYS} days</option>
              <option value="synced">Synced passkeys</option>
              <option value="inactive">Accounts that no longer sign in</option>
            </select>
            <span class="hint" id="sk-summary" data-all="${esc(summary)}">${esc(summary)}</span>
          </div>
          <table class="sk-table">
            <thead><tr><th scope="col">Key</th><th scope="col">Panel address</th><th scope="col">Added</th><th scope="col">Last used</th><th scope="col" class="action-cell"></th></tr></thead>${owners.map((entry) => userGroup(entry, settings, now)).join("")}
          </table>
          <div class="empty" id="sk-none" hidden>No key matches.</div>`}
    </div>`;
}
