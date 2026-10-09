/**
 * What CloudPanel's Sites page will look like with the switches as they stand.
 *
 * A page of its own, shown in an iframe under the switches, rather than markup
 * inside the addon's own page. Two reasons. The rules that make a card out of a
 * row are keyed to the width of the window, so only a frame of its own can be
 * asked what a phone would see while a desktop is reading the page. And the
 * look being previewed is CloudPanel's, so the frame loads CloudPanel's own
 * stylesheets from the panel it is installed beside rather than a copy of them
 * kept here, which would drift with the next panel release.
 *
 * The rows are the panel's markup for the sites this box has, down to the card
 * and the two classes on it that its dark theme keys the cell colour to, and
 * the block above them is the one the templates carry. So what is previewed is
 * the thing itself rather than a drawing of it. Other addons put links in the
 * action cell on a real page; only Manage is here, because that is the one
 * CloudPanel ships.
 */
import { esc } from "../../../lib/app-http";
import { mountPath } from "../../../lib/mount";
import { sitesBlock } from "../inject/targets";
import type { PanelTweaksState, TweakSiteView } from "../action";

/** Enough rows to show a layout, few enough to stay a preview. */
const ROWS = 5;

import PREVIEW_STYLE from "./preview.css" with { type: "text" };

function actionCell(site: TweakSiteView): string {
  return `<a href="/site/${esc(site.domain)}/settings">Manage</a>`;
}

function row(site: TweakSiteView): string {
  return `
            <tr>
              <td><a href="/site/${esc(site.domain)}/settings">${esc(site.domain)}</a></td>
              <td>${esc(site.user)}</td>
              <td>${esc(site.type.toUpperCase())}</td>
              <td class="text-end">${actionCell(site)}</td>
            </tr>`;
}

/**
 * The preview document.
 *
 * The theme is the panel's own cookie, read before anything is painted, so the
 * frame is dark exactly when the page around it is.
 */
export function previewPage(state: PanelTweaksState): string {
  const sites = state.sites.slice(0, ROWS);
  const more = state.sites.length - sites.length;
  const body = sites.length === 0
    ? `<div class="card"><div class="card-body"><p>CloudPanel has no sites to show yet.</p></div></div>`
    : `<div class="card card-table">
        <div class="card-body card-body-no-padding">
          <table class="table table-sites">
            <thead>
              <tr><th>Domain</th><th>Site User</th><th>App</th><th class="text-end">Action</th></tr>
            </thead>
            <tbody>${sites.map(row).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>Sites preview</title>
<script>
(function () {
  function syncTheme() {
    var dark = /(?:^|;\\s*)theme=dark(?:;|$)/.test(document.cookie);
    try {
      if (parent !== window) dark = parent.document.documentElement.classList.contains('dark');
    } catch (e) {}
    document.documentElement.classList.toggle('dark', dark);
  }
  syncTheme();
  try {
    if (parent !== window) new MutationObserver(syncTheme).observe(parent.document.documentElement, {
      attributes: true, attributeFilter: ['class']
    });
  } catch (e) {}
})();
</script>
<link rel="stylesheet" href="/assets/css/bootstrap.min.css">
<link rel="stylesheet" href="/assets/css/style.css">
<link rel="stylesheet" href="/assets/css/style-dark.css">
<style>${PREVIEW_STYLE}</style>
</head>
<body>
<div id="clp-preview" class="container-fluid container-limited-width">
  <div class="page-header">
    <div class="page-title"><h1>Sites</h1></div>
  </div>${sitesBlock(mountPath("panel-tweaks"), state.tweaks)}
  ${body}
  ${more > 0 ? `<p class="preview-note">${more} more site${more === 1 ? "" : "s"} on the real page.</p>` : ""}
</div>
</body>
</html>`;
}
