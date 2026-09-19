import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { WpSiteView } from "../action";

const BASE = mountPath("wp-login");

// The cards, the buttons and the narrow-screen table layout are in lib/app-ui.
const STYLE = `
.remove-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.remove-row p { margin: 0; }
`;

const SCRIPT = `
// The window is opened inside the click, before anything is awaited: one
// opened after a fetch resolves is a popup the browser blocks.
async function signIn(button) {
  const domain = button.dataset.domain;
  const target = window.open('', '_blank');
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain }),
    });
    submitToken(target, reply.data);
    busy(false);
    notify('Signing in to ' + domain + ' in a new tab.', 'ok');
  } catch (error) {
    if (target) target.close();
    busy(false);
    notify(error.message, 'error');
  }
}

// Posted rather than put in the address bar: a single-use secret in a query
// string is still a secret in the site's access log and in the browser history.
function submitToken(target, data) {
  if (!target) throw new Error('Allow pop-ups for the panel to open WordPress.');
  const form = target.document.createElement('form');
  form.method = 'POST';
  form.action = data.url;
  const field = target.document.createElement('input');
  field.type = 'hidden';
  field.name = data.field;
  field.value = data.token;
  form.appendChild(field);
  target.document.body.appendChild(form);
  form.submit();
}

async function removeHelpers(button) {
  const agreed = await confirmAction({
    title: 'Remove the sign-in helper',
    body: 'The must-use plugin is deleted from every site it is in. The next sign-in puts it back.',
    confirmLabel: 'Remove',
  });
  if (!agreed) return;
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/remove', { method: 'POST' });
    const removed = (reply.data || {}).removed || 0;
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({
      message: removed
        ? 'Removed from ' + removed + (removed === 1 ? ' site.' : ' sites.')
        : 'No site had the helper installed.',
      kind: 'ok',
    }));
    location.reload();
  } catch (error) {
    busy(false);
    notify(error.message, 'error');
  }
}

const FLASH_KEY = 'clp-wp-login-flash';

(function showCarriedFlash() {
  let carried = null;
  try {
    carried = sessionStorage.getItem(FLASH_KEY);
    if (carried) sessionStorage.removeItem(FLASH_KEY);
  } catch (e) { return; }
  if (!carried) return;
  try {
    const flash = JSON.parse(carried);
    notify(flash.message, flash.kind);
  } catch (e) {}
})();
`;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
): string {
  return renderLayout(title, content, {
    brand: "WordPress Sign-In",
    base: BASE,
    nav: [],
    css: STYLE,
    script: SCRIPT,
    updateNotice,
  });
}

function siteRow(site: WpSiteView): string {
  return `
              <tr>
                <td class="site-cell">${esc(site.domain)}</td>
                <td class="type-cell">${esc(site.application || "WordPress")}</td>
                <td data-label="Site user">${esc(site.user)}</td>
                <td data-label="Helper">${site.helper
                  ? '<span class="badge state-done">Installed</span>'
                  : '<span class="badge">Not installed</span>'}</td>
                <td class="action-cell">
                  <button class="btn" type="button" data-domain="${esc(site.domain)}" onclick="signIn(this)">Sign in</button>
                </td>
              </tr>`;
}

function sitesCard(sites: WpSiteView[]): string {
  if (sites.length === 0) {
    return `
    <div class="card card-table">
      <div class="card-header"><h2>WordPress sites</h2></div>
      <div class="empty">No site on this server has a WordPress in it.</div>
    </div>`;
  }
  return `
    <div class="card card-table">
      <div class="card-header">
        <h2>WordPress sites</h2>
        <span class="toolbar-note">${sites.length} site${sites.length === 1 ? "" : "s"}</span>
      </div>
      <div class="table-scroll">
        <table class="fleet-table">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Application</th>
              <th>Site user</th>
              <th>Helper</th>
              <th class="text-end">Action</th>
            </tr>
          </thead>
          <tbody>${sites.map(siteRow).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function removeCard(sites: WpSiteView[]): string {
  const installed = sites.filter((site) => site.helper).length;
  if (installed === 0) return "";
  return `
    <div class="card">
      <div class="card-header"><h2>The helper</h2></div>
      <div class="remove-row">
        <p>A must-use plugin sits in ${installed} site${installed === 1 ? "" : "s"} so a sign-in can be accepted. It does nothing on any other request, and uninstalling this addon removes it everywhere.</p>
        <button class="btn" type="button" onclick="removeHelpers(this)">Remove from every site</button>
      </div>
    </div>`;
}

export function dashboardView(sites: WpSiteView[]): string {
  return `
    <div class="page-heading">
      <div>
        <h1>WordPress Sign-In</h1>
        <p>Open any WordPress on this server as its first administrator, without its password.</p>
      </div>
    </div>${removeCard(sites)}${sitesCard(sites)}`;
}
