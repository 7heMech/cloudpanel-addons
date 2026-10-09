// What Panel Tweaks adds to CloudPanel's own pages.
//
// Two anchors, not six. Every authenticated tweak -- the count, the search, the
// sorting, the extra columns -- is one script and one toolbar placed above the
// sites table, which then edits the table it finds below it. Patching the
// heading, the table head, the loop body and the action cell separately would
// have been four more pieces of CloudPanel's markup to match exactly, and four
// more ways for a panel release to stop the addon.
//
// Most of what is here does not decide what is switched on: the script asks the
// addon for the current tweaks along with the site data, so a switch on the
// addon's page takes effect on the next panel page rather than at the next
// reconciliation. The four switches that decide how a page is painted before
// any reply could arrive -- the login theme, the two narrow-screen layouts and
// the row menu -- are read here instead, which is why moving one of those
// renders the templates again.

import MENU_STYLE_SOURCE from "./menu.css" with { type: "text" };
import SITES_SCRIPT_SOURCE from "./sites.client.js" with { type: "text" };
import type { AddonTarget } from "../../../lib/addon-target";
import { headerWrapStyle } from "../../../lib/panel-nav";
import { MENU_ONLY_CLASS, ROW_ACTION_CLASS, ROW_MENU_CLASS } from "../../../lib/row-actions";
import {
  APPLICATION_LABELS, CERTIFICATE_LABELS, CERTIFICATE_SHORT_LABELS, SELF_SIGNED_CERTIFICATE,
  DEFAULT_TWEAKS, readTweaks, DEFAULT_PANEL_TWEAKS_PATHS,
} from "../action";
import type { PanelTweaks } from "../action";

/** Marker that the one-time device default has already been applied. */
const SEEDED_KEY = "clp_addons_device_theme";

// Give CloudPanel's unauthenticated pages a first-visit theme that follows the
// device.
//
// The panel already ships style-dark.css and renders `html.dark` server-side,
// but it derives that purely from a `theme` cookie: the value `dark` means
// dark and no cookie at all means light. There is no stored "light", so the
// only thing missing is the first-visit default. This records that visit and,
// for a dark device, writes the same cookie as the panel's theme switch.
// Afterward the panel owns the setting on every page.
//
// This one cannot ask the addon whether it is switched on: the login page has
// no session, and every route the manager serves is behind the administrator
// gate. So the switch decides whether the markup is there at all, which is why
// changing it is the one tweak that reconciles the templates again.
const DEVICE_THEME_SCRIPT = `
          <script>
            (function () {
              try {
                // Record the first visit even when the panel already has a dark
                // cookie. If the user later switches to light, the panel deletes
                // that cookie and this marker keeps the choice from being reset.
                if (localStorage.getItem("${SEEDED_KEY}")) return;
                localStorage.setItem("${SEEDED_KEY}", "1");
                if (/(?:^|;\\s*)theme=/.test(document.cookie)) return;
                if (!window.matchMedia("(prefers-color-scheme: dark)").matches) return;
                // Byte for byte the cookie the panel's own #theme-switch writes
                // with Cookies.set("theme", "dark", { expires: 180, secure: true }),
                // so its switch clears exactly this cookie later.
                document.cookie = "theme=dark; path=/; expires=" +
                  new Date(Date.now() + 180 * 864e5).toUTCString() +
                  (location.protocol === "https:" ? "; secure" : "");
                document.documentElement.classList.add("dark");
              } catch (e) {}
            })();
          </script>`;

// What the enhanced table looks like on a screen wide enough for a table.
import SITES_STYLE from "./sites.css" with { type: "text" };

// The narrow-screen half, which is a switch of its own: it is the panel's own
// table it rearranges, and an operator who prefers to scroll it should be able
// to. Keyed on CloudPanel's own `table-sites` rather than on a class the script
// adds, so it is in force the moment the browser parses the page. Keyed on the
// added class, a phone painted the panel's four-column table first and
// rearranged it into cards once the fetch came back -- the layout moved under
// the reader for as long as the request took.
//
// The native cells are labelled as soon as the table exists; only the added
// columns need the fetched data.
import SITES_MOBILE_STYLE from "./sites-mobile.css" with { type: "text" };

// The menu uses the otherwise empty far-right end of the values. It is outside
// the grid, so it cannot change either detail column's starting position.
import MENU_MOBILE_STYLE from "./menu-mobile.css" with { type: "text" };

/**
 * The action column's links, behind one button.
 *
 * The links are hidden by a class this snippet puts on <html> before the table
 * is parsed rather than by one the script adds once it has run: added later,
 * the reader would see the links and then watch them disappear. The script
 * takes the class off again if it cannot find the table, so a page it does not
 * recognise keeps its links rather than losing them to a menu that was never
 * built.
 *
 * An open menu is a child of <body>, not of the cell it belongs to: the table
 * sits in a horizontal scroller, which clips anything hanging out of it.
 */
const MENU_STYLE = MENU_STYLE_SOURCE.split("ROW_MENU_CLASS").join(ROW_MENU_CLASS);

// Written for the panel's page, not for an addon page: no shared client code
// reaches here, so this is plain ES5 with its own fetch and its own escaping.
// Everything it writes into a cell goes in as text or as an element it built,
// never as markup, because every value in it came out of somebody's database.
const SITES_SCRIPT = SITES_SCRIPT_SOURCE
  .split("MENU_ONLY_CLASS").join(MENU_ONLY_CLASS)
  .split("ROW_ACTION_CLASS").join(ROW_ACTION_CLASS)
  .split("ROW_MENU_CLASS").join(ROW_MENU_CLASS);

/**
 * CloudPanel's header on a screen narrower than the desktop it was drawn on.
 *
 * The header is one non-wrapping flex row of a fixed 75px: a 235px logo, the
 * navigation, and the tools. It has no narrow-screen layout at all, so on a
 * phone the avatar and the Admin Area link sit off the right edge of the page
 * with nothing to scroll them back.
 *
 * What lets the row wrap at all is shared with the manager, which asks for the
 * same rules while an update notice is in the row. Everything else here is what
 * only a narrow screen wants. These rules carry a `body` in front to keep their
 * narrow-screen overrides strong. The manager's later update block repeats the
 * navigation row placement while a notice is present, so its shared flex
 * shorthand cannot collapse that row.
 */
const PANEL_HEADER_STYLE = headerWrapStyle("body .header") + `
/* Bootstrap draws the avatar's caret from the font size it inherits, which is
   the page's rather than the avatar's, and the addon's own header draws it at a
   fixed size. */
body .header .navbar-right > ul > li.user-avatar > a.dropdown-toggle::after { border-top-width: 4px;
  border-right-width: 4px; border-left-width: 4px; margin-left: 4px; }
@media (max-width: 960px) {
  body .header .nav-link-container,
  body .header .header-instance-information-container { order: 2; flex-basis: 100%;
    border-top: 1px solid #e2e2e2; }
  html.dark body .header .nav-link-container,
  html.dark body .header .header-instance-information-container { border-top-color: var(--clp-border-color); }
  /* The links become their own row, and scroll it rather than the page when a
     translation makes them wider than the phone they are on. */
  body .header .nav-link-container { display: flex; overflow-x: auto; scrollbar-width: none; }
  body .header .nav-link-container::-webkit-scrollbar { display: none; }
  body .header .nav-link-container > a { flex: 0 0 auto; margin-left: 0; line-height: 48px; }
}
/* Below this the header is the shape the addon's own pages use: one 64px row of
   the logo and the tools, in equal cells with the panel's own divider between
   them, and the navigation on the row beneath. The panel's 75px row and its
   25px cell padding are drawn for a desktop and only crowd a phone. */
@media (max-width: 760px) {
  body .header { min-height: 0; }
  /* The divider belongs to the first tool, not to the logo, or a phone gets two
     of them next to each other. html.dark body sets it as well, and outranks a
     rule scoped to the header alone. */
  body .header .logo,
  html.dark body .header .logo { display: flex; align-items: center; min-width: 0; min-height: 64px;
    padding: 0 20px; margin: 0; border: 0; }
  body .header .logo img { max-width: 100%; height: auto; }
  body .header .navbar-right { height: auto; padding: 0; }
  body .header .navbar-right > ul > li { height: 64px; line-height: 1; }
  body .header .navbar-right > ul > li > a { display: flex; align-items: center; justify-content: center;
    width: 56px; height: 64px; padding: 0; }
  /* The panel nudges each icon by a pixel or two to sit beside the text it no
     longer has here, and it names the list item to do it -- so the reset has to
     name the item too, or the icon lands off the centre of its cell. */
  body .header .navbar-right > ul > li.theme-switcher > a svg,
  body .header .navbar-right > ul > li.admin-area > a svg,
  body .header .navbar-right > ul > li > a svg { width: 20px; height: 20px; margin: 0; }
  /* The label goes, the icon stays: "Admin Area" beside an avatar and a theme
     switch is the one thing that will not fit beside a 155px logo. */
  body .header .navbar-right > ul > li.admin-area > a { font-size: 0; }
  body .header .navbar-right > ul > li.user-avatar > a { width: 66px; }
  body .header .navbar-right > ul > li.user-avatar > a img { width: 26px; height: 26px; }
  /* The navigation starts where the logo does, and the rule between the two
     rows is the one the panel draws everywhere else rather than a tenth of it. */
  body .header .nav-link-container { padding: 0 5px; border-top: 1px solid #e2e2e2; }
  html.dark body .header .nav-link-container { border-top-color: var(--clp-border-color); }
  body .header .nav-link-container > a { padding: 0 15px; }
  /* CloudPanel draws its dashboard charts at a fixed 545px, which is wider than
     the phone they are on, and the information boxes at a fixed 240px. The
     container is a flex row of two-chart rows, so widening a chart to its row
     only splits the screen between them: the rows have to stop sharing a line
     first. */
  body .chart-container { display: block; }
  body .chart-container .chart-row { width: auto; }
  body .chart-container .chart { width: 100%; margin: 12px 0; }
  body .chart-container .chart .chart-content { overflow-x: auto; }
  body .chart-container .chart canvas { max-width: 100%; }
  body .information-box { width: auto; min-width: 0; margin: 12px 20px; }
}
`;

/**
 * CloudPanel's new-site pages on a screen narrower than the desktop they were
 * drawn on.
 *
 * The chooser and every new-site form live in a fixed 800px container, so on a
 * phone the page scrolls sideways. The chooser lays its site types out as
 * fixed 340px cards two to a row, and the forms put their fields in `col-6`
 * halves that Bootstrap never stacks on its own. Below 760px the container
 * becomes the viewport and the cards become one centred column; below 576px --
 * Bootstrap's own point for stacking columns -- each half takes the whole row,
 * with the row's own spacing between the stacked halves. These rules carry a
 * `body` in front for the same reason the header's do.
 */
const NEW_SITE_STYLE = `
@media (max-width: 760px) {
  body .new-site-container-fix { width: auto; max-width: 800px; }
  body .new-site-container .page-header .page-title h1 { font-size: 24px; }
  body .site-type-container { justify-content: center; }
  body .site-type-container .application,
  body .site-type-container .application:nth-child(2n),
  body .site-type-container .application:nth-child(4n) { width: 100%; max-width: 420px; height: auto;
    margin: 0 0 20px; }
  body .site-type-container .application-image img { max-width: 100%; height: auto; }
  body .new-site-container .deploy-application-container .btn { white-space: normal; }
}
@media (max-width: 576px) {
  body .new-site-container .card-form .row > .col-6 { width: 100%; }
  body .new-site-container .card-form .row > .col-6 + .col-6 { margin-top: 20px; }
}
`;

/**
 * The switches as they stood when the templates were last rendered.
 *
 * Root work, and the only place the stored tweaks can be read from. An empty
 * snippet still leaves its marker pair behind, which is what lets the next
 * reconciliation notice a switch move back.
 */
function storedTweaks(): PanelTweaks {
  try {
    return readTweaks(DEFAULT_PANEL_TWEAKS_PATHS);
  } catch {
    // Unreadable state is the default state.
    return DEFAULT_TWEAKS;
  }
}

/**
 * The whole block, without the Twig that guards it on a panel page.
 *
 * The addon's own page renders this into the preview under its switches, where
 * there is no Twig and no administrator test to make: the route that serves it
 * is already behind the same gate as every other route the manager has.
 */
export function sitesBlock(url: string, tweaks: PanelTweaks = storedTweaks()): string {
  const style = SITES_STYLE
    + (tweaks.sitesMobile ? SITES_MOBILE_STYLE : "")
    + (tweaks.actionMenu ? MENU_STYLE : "")
    + (tweaks.actionMenu && tweaks.sitesMobile ? MENU_MOBILE_STYLE : "");
  // Set here rather than when the script below runs, so the rule that hides the
  // panel's own action links is already in force when the table is parsed.
  const menuClass = tweaks.actionMenu
    ? `\n          <script>document.documentElement.classList.add("clp-tweaks-menu");</script>`
    : "";
  // Shown from the markup rather than when the reply lands: revealing it later
  // pushed the table down, which was the largest layout shift on the page. The
  // script hides it again on a page whose table it does not recognise.
  const toolbarHidden = tweaks.sitesTable ? "" : " hidden";
  return `
          <style>${style}</style>${menuClass}
          <div class="clp-tweaks-toolbar" id="clp-tweaks-toolbar"${toolbarHidden}>
            <input type="search" id="clp-tweaks-search" class="form-control" placeholder="Search sites" aria-label="Search sites">
            <select id="clp-tweaks-type" class="form-select" aria-label="Filter by application">
              <option value="">All applications</option>
            </select>
            <div class="clp-tweaks-columns" id="clp-tweaks-columns"${toolbarHidden}>
              <button type="button" class="form-control clp-tweaks-columns-button" id="clp-tweaks-columns-button"
                aria-haspopup="true" aria-expanded="false">Columns</button>
              <div class="clp-tweaks-columns-menu" id="clp-tweaks-columns-menu" role="group" aria-label="Columns" hidden></div>
            </div>
            <span class="clp-tweaks-summary" id="clp-tweaks-summary" role="status"></span>
          </div>
          <script>${SITES_SCRIPT.split("ADDON_URL").join(url)
  .replace("CERTIFICATE_LABELS_JSON", JSON.stringify(CERTIFICATE_LABELS))
  .replace("CERTIFICATE_SHORT_LABELS_JSON", JSON.stringify(CERTIFICATE_SHORT_LABELS))
  .replace("APPLICATION_LABELS_JSON", JSON.stringify(APPLICATION_LABELS))
  .replace("SELF_SIGNED_JSON", JSON.stringify(SELF_SIGNED_CERTIFICATE))
  .replace("SITES_TABLE_JSON", JSON.stringify(tweaks.sitesTable))}</script>`;
}

/**
 * Emitted for every panel user, not only administrators: the Sites page is one
 * CloudPanel shows them all, and the reply the script reads is narrowed to the
 * rows the page already drew for the reader.
 */
function sitesSnippet(url: string, tweaks: PanelTweaks = storedTweaks()): string {
  return `
          ${sitesBlock(url, tweaks)}`;
}

/** The login page's script, or nothing at all. */
export function deviceThemeSnippet(on: boolean): string {
  return on ? DEVICE_THEME_SCRIPT : "";
}

/** The narrow-screen header and new-site rules, or nothing at all. */
export function panelMobileSnippet(on: boolean): string {
  return on ? `<style>${PANEL_HEADER_STYLE}${NEW_SITE_STYLE}</style>` : "";
}

export const SITES_TEMPLATE = "Frontend/Site/index.html.twig";

/** Both headers carry the same opening tag, and both want the same rules. */
export const HEADER_TEMPLATES = ["Frontend/Partial/header.html.twig", "Admin/Partial/header.html.twig"];

export { sitesSnippet };

export const PANEL_TWEAKS_TARGETS: AddonTarget[] = [
  {
    slug: "login-device-theme",
    template: "Frontend/Login/layout.html.twig",
    // The shared layout every unauthenticated page extends (login, two-factor).
    // Injecting into its <head> runs before the stylesheets load, so a dark
    // device never paints the white default first.
    anchorBefore: "{% block stylesheets %}",
    required: true,
    snippet: () => deviceThemeSnippet(storedTweaks().deviceTheme),
  },
  {
    slug: "sites-table",
    template: SITES_TEMPLATE,
    anchorBefore: '<div class="card card-table">',
    // Not required: a CloudPanel release that renames this card should cost the
    // sites table its enhancements, not stop the addon -- and with it the login
    // theme -- from being enabled at all.
    required: false,
    snippet: (url) => sitesSnippet(url),
  },
  ...HEADER_TEMPLATES.map((template, index) => ({
    slug: index === 0 ? "header-frontend" : "header-admin",
    template,
    // Ahead of the header rather than inside it, so one anchor serves both of
    // CloudPanel's headers and neither depends on what is in them.
    anchorBefore: '<header class="header d-flex">',
    required: false,
    snippet: () => panelMobileSnippet(storedTweaks().panelMobile),
  })),
];
