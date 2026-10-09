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

import SITE_EMBED_SOURCE from "./assets/site-embed.client.js" with { type: "text" };
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
export const SITE_EMBED_SCRIPT = SITE_EMBED_SOURCE
  .split("EMBED_TABS_JSON").join(EMBED_TABS)
  .split("EMBED_MARKER").join(EMBED_MARKER)
  .split("EMBED_LANDING_CLASS").join(EMBED_LANDING_CLASS);
