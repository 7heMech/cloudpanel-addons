import CLIENT_JS from "./views.client.js" with { type: "text" };
import STYLE from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { Settings, UserKeysView } from "./service";

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

function when(iso: string | null, length: 10 | 16): string {
  return iso ? `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(iso.slice(0, length).replace("T", " "))}</time>` : "Never";
}

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

export function dashboardView({ users, settings }: { users: UserKeysView[]; settings: Settings }): string {
  const rows = users.flatMap((entry) => entry.keys.map((key) => `
    <tr>
      <td class="site-cell">${entry.active ? "" : '<span class="badge state-failed">No longer signs in</span> '}${esc(entry.user)}</td>
      <td data-label="Key">${key.synced ? `<span class="badge${settings.syncedPasskeys ? "" : " state-failed"}">Synced passkey</span> ` : ""}${esc(key.name)}</td>
      <td data-label="Panel address" class="mono">${esc(new URL(key.origin).host)}</td>
      <td data-label="Added">${when(key.createdAt, 10)}</td>
      <td data-label="Last used (UTC)">${when(key.lastUsedAt, 16)}</td>
      <td class="action-cell"><button class="btn btn-danger" type="button" data-user="${esc(entry.user)}" data-id="${esc(key.id)}" data-name="${esc(key.name)}" onclick="revokeKey(this)">Remove</button></td>
    </tr>`)).join("");
  const count = users.reduce((total, entry) => total + entry.keys.length, 0);

  return `
    <div class="page-heading">
      <div><h1>Security Keys</h1><p>Passkeys and hardware keys that sign in to CloudPanel without a password. Each user adds their own under <a href="/security">Account → Security</a>.</p></div>
    </div>
    <div class="notice" id="sk-address" hidden>This panel is open on an IP address. Security keys work only on a hostname with a valid certificate, so open the panel on its domain to add or use one.</div>
    ${settingsCard(settings)}
    <div class="card card-table">
      ${count === 0
        ? '<div class="empty">No security keys yet.</div>'
        : `<table class="fleet-table security-key-table">
            <thead><tr>
              <th scope="col">User</th><th scope="col">Key</th><th scope="col">Panel address</th><th scope="col">Added</th><th scope="col">Last used (UTC)</th><th scope="col" class="action-cell"></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>`;
}
