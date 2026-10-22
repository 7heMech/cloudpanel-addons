import CLIENT_JS from "./views.client.js" with { type: "text" };
import STYLE from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { UserKeysView } from "./service";

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

export function dashboardView(users: UserKeysView[]): string {
  const rows = users.flatMap((entry) => entry.keys.map((key) => `
    <tr>
      <td class="site-cell">${esc(entry.user)}${entry.active ? "" : ' <span class="badge state-failed">No longer signs in</span>'}</td>
      <td data-label="Key">${esc(key.name)}${key.synced ? ' <span class="badge">Synced passkey</span>' : ""}</td>
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
