// Theme & Branding on CloudPanel's own pages: one block in the head of each of
// its three layouts, and one in the footer.
//
// Everything the operator wrote is inside `{% verbatim %}`, and `branding.ts`
// refuses the one word that would end it, so none of it is read as Twig.
// Images are not inlined: the block names them under the addon's mount, where
// they are answered before the session gate because the login page has none.

import type { AddonTarget } from "../../../lib/addon-target";
import { TEMPLATES } from "../../../lib/panel-anchors";
import { DEFAULT_PANEL_TWEAKS_PATHS, readTweaks } from "../action";
import { DEFAULT_BRANDING, readBranding, twigSafe, type Branding } from "../branding";

/** Every layout's own scripts follow its stylesheets, so this is after them. */
const HEAD_ANCHOR = "{% block javascript %}";
const FOOTER_ANCHOR = "    </ul>\n  </div>\n</footer>";

/**
 * Puts the uploaded logos into `.logo img` as the parser reaches them, before
 * they are painted. The header's `#logo` gets them in the data attributes the
 * panel's own theme switch reads, so that switch keeps working. The square mark
 * is for the login pages and for a phone's header; either pair falls back to
 * the other, and either theme to the other theme.
 */
const LOGO_SCRIPT = `(function () {
  var L = LOGOS_JSON, html = document.documentElement, narrow = window.matchMedia("(max-width: 760px)");
  function pair(p) { return p[0] || p[1] ? [p[0] || p[1], p[1] || p[0]] : null; }
  var header = pair(L.header), mark = pair(L.mark);
  function brand(img) {
    var p = mark && (!img.id || narrow.matches || !header) ? mark : header;
    if (!p) return;
    img.classList.add("clp-tweaks-logo");
    if (img.id === "logo") { img.setAttribute("data-light-img-src", p[0]); img.setAttribute("data-dark-img-src", p[1]); }
    img.src = html.classList.contains("dark") ? p[1] : p[0];
  }
  function scan(all) {
    var imgs = document.querySelectorAll(".logo img");
    for (var i = 0; i < imgs.length; i++) if (all || !imgs[i].classList.contains("clp-tweaks-logo")) brand(imgs[i]);
  }
  var icons = document.querySelectorAll('link[rel~="icon"]:not([data-clp-tweaks])');
  if (document.querySelector('link[rel~="icon"][data-clp-tweaks]')) for (var i = 0; i < icons.length; i++) icons[i].remove();
  var observer = new MutationObserver(function () { scan(false); });
  observer.observe(html, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", function () { observer.disconnect(); scan(false); });
  if (narrow.addEventListener) narrow.addEventListener("change", function () { scan(true); });
})();`;

/** CloudPanel's footer keeps its language selector; the operator's items replace its links. */
const FOOTER_STYLE = ".footer ul:has(> .clp-tweaks-footer) > li:not(.locale-selector):not(.clp-tweaks-footer ~ li) { display: none; }";

/** The panel's Update available button lives in a link item; it moves to the operator's last one. */
const FOOTER_SCRIPT = `(function () {
  // Gone once run, so the last item is the list's last child and gets no separator.
  if (document.currentScript) document.currentScript.remove();
  var start = document.querySelector(".footer .clp-tweaks-footer"), button = document.getElementById("update-available-button");
  var items = start ? start.parentNode.querySelectorAll(":scope > li") : [];
  var last = items[items.length - 1];
  if (button && last && last !== start) { last.appendChild(document.createTextNode(" ")); last.appendChild(button); }
})();`;

function verbatim(markup: string): string {
  return markup && twigSafe(markup) ? `{% verbatim %}${markup}{% endverbatim %}` : "";
}

function storedBranding(): { on: boolean; branding: Branding } {
  try {
    return { on: readTweaks(DEFAULT_PANEL_TWEAKS_PATHS).branding, branding: readBranding(DEFAULT_PANEL_TWEAKS_PATHS) };
  } catch {
    return { on: false, branding: DEFAULT_BRANDING };
  }
}

export function brandingHeadSnippet(url: string, branding: Branding): string {
  const asset = (name: string) => name ? `${url}/branding/${name}` : "";
  const { logos } = branding;
  let head = "";
  const css: string[] = [];
  if (branding.customLogo) {
    if (logos.favicon) {
      const type = logos.favicon.endsWith(".svg") ? "image/svg+xml" : logos.favicon.endsWith(".ico") ? "image/x-icon" : "image/png";
      head += `<link rel="icon" type="${type}" href="${asset(logos.favicon)}" data-clp-tweaks>`;
    }
    const touch = logos.markLight || logos.markDark;
    if (touch) head += `<link rel="apple-touch-icon" href="${asset(touch)}">`;
    const json = JSON.stringify({
      header: [asset(logos.headerLight), asset(logos.headerDark)],
      mark: [asset(logos.markLight), asset(logos.markDark)],
    });
    if (Object.values(logos).some(Boolean)) head += `<script>${LOGO_SCRIPT.replace("LOGOS_JSON", json)}</script>`;
    css.push(".logo img.clp-tweaks-logo { width: auto; max-width: 100%; object-fit: contain; }",
      ".header .logo img.clp-tweaks-logo { height: 31px; }");
  }
  if (!branding.showFooter) css.push("body > footer.footer { display: none !important; }");
  else if (branding.footerHtml.trim()) css.push(FOOTER_STYLE);
  if (branding.customCss && branding.css.trim()) css.push(branding.css.replace(/<\/style/gi, "<\\/style"));
  if (css.length) head += `<style data-clp-tweaks-branding>${css.join("\n")}</style>`;
  return verbatim(head);
}

export function brandingFooterSnippet(branding: Branding): string {
  if (!branding.showFooter || !branding.footerHtml.trim()) return "";
  return verbatim(`<li class="clp-tweaks-footer" hidden></li>${branding.footerHtml}<script>${FOOTER_SCRIPT}</script>`);
}

export function brandingTargets(): AddonTarget[] {
  const head = [TEMPLATES.layout, TEMPLATES.adminLayout, TEMPLATES.loginLayout].map((template, index): AddonTarget => ({
    slug: ["branding-head", "branding-head-admin", "branding-head-login"][index]!,
    template,
    anchorBefore: HEAD_ANCHOR,
    // A panel release that moves this costs the branding, not the addon.
    required: false,
    snippet: (url) => {
      const { on, branding } = storedBranding();
      return on ? brandingHeadSnippet(url, branding) : "";
    },
  }));
  return [...head, {
    slug: "branding-footer",
    template: TEMPLATES.footer,
    anchorBefore: FOOTER_ANCHOR,
    required: false,
    snippet: () => {
      const { on, branding } = storedBranding();
      return on ? brandingFooterSnippet(branding) : "";
    },
  }];
}
