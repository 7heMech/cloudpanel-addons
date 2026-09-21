// Mounting an addon page inside CloudPanel's own site page.
//
// A site-scoped addon page reached from the panel's tab strip used to redraw
// the panel's chrome from lib/site-context: a reproduction that has to be kept
// in step with markup we do not own. Here the panel draws its own header, site
// information and tab strip, and only the content below them comes from the
// addon -- mounted in a shadow root, so the panel's Bootstrap cannot reach our
// markup and our stylesheet cannot reach theirs.
//
// The addon serves that content as a fragment: stylesheet, markup and script,
// with no document around it. A direct visit to the addon's own URL redirects
// into the panel page instead, so the address bar still names the page and a
// refresh still works.

import { ADDON_SITE_TABS } from "./site-context";

/** Query parameter that tells the loader to mount as soon as the page lands. */
export const EMBED_MARKER = "clp-addon";

/** The panel route a deep link is sent to; any site route draws the chrome. */
export function embedLandingUrl(domain: string, slug: string): string {
  return `/site/${encodeURIComponent(domain)}/settings?${EMBED_MARKER}=${encodeURIComponent(slug)}`;
}

/**
 * The shell's stylesheet, rewritten for a shadow root.
 *
 * Inside a shadow tree a selector cannot reach the document, so `:root` and
 * `html.dark` match nothing; the host element carries both instead. The page
 * rules that style the document itself are dropped, because in the panel the
 * document belongs to CloudPanel.
 */
export function shadowStyle(css: string): string {
  return css
    .replace(/(^|\n)html\.dark /g, "$1:host(.dark) ")
    .replace(/(^|\n):root \{/g, "$1:host {")
    .replace(
      /(^|\n)body \{[^}]*\}/g,
      "$1:host { display: block; color: var(--text); font-family: var(--clp-addon-font-family);\n  font-size: 16px; line-height: 1.5; }",
    );
}

/** What an addon returns for a page that mounts inside the panel. */
export interface EmbedFragment {
  ok: true;
  title: string;
  css: string;
  html: string;
  script: string;
}

const EMBED_TABS = JSON.stringify(ADDON_SITE_TABS.map((tab) => ({ slug: tab.slug, url: tab.url })));

/** On `<html>` while a deep-landed page waits for the fragment that replaces
 * the panel's content. Without it the settings page the redirect passed through
 * paints first and is then thrown away, which reads as the wrong page. */
export const EMBED_LANDING_CLASS = "clp-addon-embedding";

/** Hidden rather than removed, so the content area holds its height. */
export const SITE_EMBED_STYLE = `html.${EMBED_LANDING_CLASS} .site-content { visibility: hidden; }`;

/**
 * The loader injected into the panel's site pages next to the tab strip.
 *
 * It replaces the panel's content area with the addon's fragment when its tab
 * is clicked, and on landing when a deep link redirected here. Anything it
 * cannot do -- a failed fetch, a modified click, a browser without shadow DOM
 * -- falls through to following the link, which the addon still answers.
 *
 * Runs as the panel parses the page, because a deep link knows which fragment
 * it wants from the URL alone: that request goes out while the panel's own
 * markup is still being parsed rather than after it. Only the half that reads
 * markup waits for the document, since this block sits ahead of it.
 */
export const SITE_EMBED_SCRIPT = `(function () {
  var TABS = ${EMBED_TABS};
  var landed = new URLSearchParams(location.search).get("${EMBED_MARKER}");
  // Which addon tab is mounted in this document, "" for none. A slug rather
  // than a flag because the three questions this answers are different: whether
  // to reload on popstate, whether a click is on the tab already shown, and
  // whether a click is on a different addon tab.
  var shown = "";
  var mounting = false;
  var strip = null;
  var content = null;
  // The deep link's fragment, in flight before the document is ready.
  var early = landed ? prefetch(landed) : null;

  // A reply is never a rejected promise: mount attaches to it only once the
  // document is ready, which can be after a fetch this started has already
  // failed.
  function fetchFragment(tab, query) {
    return fetch(tab.url + "/fragment?" + query, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) { return res.json(); })
      .catch(function () { return null; });
  }

  function siteDomain() {
    return decodeURIComponent(location.pathname.split("/")[2] || "");
  }

  function tabFor(slug) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].slug === slug) return TABS[i];
    return null;
  }

  // The panel's content is hidden from the moment the request goes out, and
  // revealed by whatever finishes: the mount, the fallback to the addon's own
  // page, or the timer, which is what keeps a page this never reached from
  // staying blank.
  function prefetch(slug) {
    var tab = tabFor(slug);
    var domain = siteDomain();
    if (!tab || !domain) return null;
    document.documentElement.classList.add("${EMBED_LANDING_CLASS}");
    setTimeout(reveal, 5000);
    return fetchFragment(tab, "domain=" + encodeURIComponent(domain));
  }

  function reveal() {
    document.documentElement.classList.remove("${EMBED_LANDING_CLASS}");
  }

  // Every way this can fail ends at the standalone page, which answers without
  // redirecting here again. Sending a failure back to the tab link would bounce
  // through the redirect and land right back on this loader.
  function standalone(href) {
    reveal();
    location.href = href + (href.indexOf("?") === -1 ? "?" : "&") + "embed=0";
  }

  // This reads markup CloudPanel owns, so a panel release can take it away.
  // Say so once, and when the operator asked for a page -- a deep link was
  // redirected here -- hand them the addon's own copy rather than leave them
  // looking at the settings page they never asked for.
  function unavailable(reason) {
    if (window.console && console.warn) {
      console.warn("clp-addons: " + reason + "; addon pages open on their own instead.");
    }
    var tab = landed ? tabFor(landed) : null;
    var domain = siteDomain();
    if (tab && domain) standalone(tab.url + "?domain=" + encodeURIComponent(domain));
    else reveal();
  }

  function attach() {
    strip = document.querySelector(".tab-container");
    content = document.querySelector(".site-content");
    if (!strip || !content) return unavailable("this CloudPanel site page has no tab strip or content area");

    TABS.forEach(function (tab) {
      var link = strip.querySelector('a[href^="' + tab.url + '?"]');
      if (!link) {
        if (landed === tab.slug) unavailable("the " + tab.slug + " tab is not in this site's tab strip");
        return;
      }
      link.addEventListener("click", function (event) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        // Clicking the tab of the page already shown is a no-op.
        if (shown === tab.slug) return event.preventDefault();
        // A different addon tab, with one already mounted, is handed to the
        // browser rather than swapped in place. One document still gets one
        // mount: the fragment's script runs at global scope and declares its
        // helpers with const, so a second fragment would throw on its own script
        // and leave the first one's root visible under the second one's title.
        // Following the link costs a page load and lands on the panel page that
        // mounts the other addon cleanly.
        if (shown || mounting) return;
        event.preventDefault();
        mount(tab, link, true);
      });
      // Marked before the fragment lands, not after it: the strip is the
      // panel's own markup and still shows Settings as the tab the redirect
      // passed through.
      if (landed === tab.slug) {
        markActive(link);
        mount(tab, link, false);
      }
    });
  }

  function markActive(link) {
    var items = strip.querySelectorAll("ul li");
    for (var i = 0; i < items.length; i++) items[i].classList.remove("active");
    var item = link.parentNode;
    if (item && item.tagName === "LI") item.classList.add("active");
    // The strip was scrolled to whichever tab was active when the page loaded,
    // which is no longer the tab being shown.
    var list = strip.querySelector("ul");
    if (list && list.scrollWidth > list.clientWidth) link.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // The panel owns the theme; the host mirrors it so :host(.dark) applies.
  function followTheme(host) {
    function sync() { host.classList.toggle("dark", document.documentElement.classList.contains("dark")); }
    sync();
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }

  // Held from here, not from the reply: the fragment's script runs at global
  // scope and declares CLP_BASE and CLP_ROOT with const, so a second mount that
  // started while this one was in flight would throw on its own script and
  // leave the visible root pointing at the one this replaced.
  function mount(tab, link, push) {
    var href = link.getAttribute("href");
    if (!Element.prototype.attachShadow) return standalone(href);
    mounting = true;
    var query = href.indexOf("?") === -1 ? "" : href.slice(href.indexOf("?") + 1);
    // The landing mount takes the reply already in flight; a click asks now.
    // Taken once, so a later click on the same tab fetches again.
    var reply = !push && early ? early : fetchFragment(tab, query);
    early = null;
    reply
      .then(function (payload) {
        if (!payload || payload.ok !== true) throw new Error("fragment unavailable");
        var host = document.createElement("div");
        var root = host.attachShadow({ mode: "open" });
        root.innerHTML = "<style>" + payload.css + "</style>" + payload.html;
        content.textContent = "";
        content.appendChild(host);
        followTheme(host);
        // Run the fragment's script at global scope, not in a closure: the
        // markup calls its functions from inline handlers, and those resolve
        // against the global scope. A script element inserted as HTML never
        // executes, so it is created here. CLP_MOUNT is how the script learns
        // which root its element lookups are relative to.
        window.CLP_MOUNT = root;
        var script = document.createElement("script");
        script.textContent = payload.script;
        document.head.appendChild(script);
        markActive(link);
        reveal();
        if (payload.title) document.title = payload.title;
        shown = tab.slug;
        mounting = false;
        history[push ? "pushState" : "replaceState"]({ clpAddon: tab.slug }, "", href);
      })
      .catch(function () { mounting = false; standalone(href); });
  }

  // Leaving the addon means going back to a page the panel renders, and its own
  // scripts bound to content this replaced, so hand the navigation back.
  window.addEventListener("popstate", function () { if (shown) location.reload(); });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, { once: true });
  else attach();
})();`;
