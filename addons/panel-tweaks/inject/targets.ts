// What Panel UI tweaks adds to CloudPanel's own pages.
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

import type { AddonTarget } from "../../../lib/addon-target";
import { headerWrapStyle } from "../../../lib/panel-nav";
import { MENU_ONLY_CLASS, ROW_MENU_CLASS } from "../../../lib/row-actions";
import {
  APPLICATION_LABELS, CERTIFICATE_LABELS, SELF_SIGNED_CERTIFICATE,
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
const SITES_STYLE = `
.clp-tweaks-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 20px; }
.clp-tweaks-toolbar input[type="search"] { flex: 1 1 260px; min-width: 0; max-width: 420px; }
.clp-tweaks-toolbar select { flex: 0 0 auto; width: auto; }
.clp-tweaks-toolbar .clp-tweaks-summary { margin-left: auto; color: #9bacb6; font-size: 14px; }
.clp-tweaks-count { display: inline-block; margin-left: 12px; padding: 2px 10px; border: 1px solid currentColor;
  border-radius: 99px; color: #9bacb6; font-size: 14px; font-weight: 600; vertical-align: middle; }
.clp-tweaks-table th.clp-tweaks-sortable { cursor: pointer; user-select: none; white-space: nowrap; }
.clp-tweaks-table th.clp-tweaks-sortable::after { content: "\\2195"; margin-left: 6px; opacity: .35; }
.clp-tweaks-table th.clp-tweaks-asc::after { content: "\\2191"; opacity: 1; }
.clp-tweaks-table th.clp-tweaks-desc::after { content: "\\2193"; opacity: 1; }
.clp-tweaks-table .clp-tweaks-badge { display: inline-block; padding: 2px 8px; border: 1px solid currentColor;
  border-radius: 4px; font-size: 12px; line-height: 1.4; white-space: nowrap; }
.clp-tweaks-table .clp-tweaks-ok { color: #23774b; }
.clp-tweaks-table .clp-tweaks-warn { color: #936319; }
.clp-tweaks-table .clp-tweaks-none { color: #9bacb6; }
.clp-tweaks-table .clp-tweaks-size { font-variant-numeric: tabular-nums; white-space: nowrap; }
.clp-tweaks-table .clp-tweaks-muted { color: #9bacb6; }
.clp-tweaks-empty { padding: 25px; color: #9bacb6; }
/* CloudPanel pads its cells 32px each side, which is comfortable for four
   columns and overflows the 1200px container at six. The table is also given a
   scroller, so a narrow window scrolls the table rather than the page.
   .card .card-body-no-padding .table td is what the panel sets the cell padding
   with and .table thead th what it sets the heading padding with, so the
   override has to carry the heavier of the two or the headings move and the
   cells do not. */
.clp-tweaks-scroll { overflow-x: auto; }
.card .card-body-no-padding table.table-sites th,
.card .card-body-no-padding table.table-sites td { padding-left: 20px; padding-right: 20px; }
@media (max-width: 860px) {
  .clp-tweaks-toolbar .clp-tweaks-summary { margin-left: 0; flex-basis: 100%; }
}
`;

// The narrow-screen half, which is a switch of its own: it is the panel's own
// table it rearranges, and an operator who prefers to scroll it should be able
// to. Keyed on CloudPanel's own `table-sites` rather than on a class the script
// adds, so it is in force the moment the browser parses the page. Keyed on the
// added class, a phone painted the panel's four-column table first and
// rearranged it into cards once the fetch came back -- the layout moved under
// the reader for as long as the request took.
//
// What the script cannot do before its data arrives is name the columns, so the
// rules that need `data-label` are the ones that wait, and they add text inside
// a cell rather than moving it.
const SITES_MOBILE_STYLE = `
@media (max-width: 860px) {
  .clp-tweaks-scroll { overflow-x: visible; }
  table.table-sites, table.table-sites tbody, table.table-sites tr, table.table-sites td { display: block; }
  table.table-sites thead { display: none; }
  /* Blocks and flex items ignore the hidden attribute's default styling, and
     the search below the heading is what sets it. */
  table.table-sites tr[hidden], table.table-sites td[hidden] { display: none; }
  /* The cells lose their borders as blocks, so the row draws the only rule left
     telling one site from the next. The panel's own table border, in both of
     its themes, rather than a grey of this addon's choosing. */
  table.table-sites tr { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 14px 12px;
    padding: 16px 20px; border-top: 1px solid #eaeaea; }
  html.dark table.table-sites tr { border-top-color: var(--clp-border-color); }
  table.table-sites tbody tr:first-child { border-top: 0; }
  /* The panel sets these with html.dark body .table td, which outranks anything
     scoped to one table, so the reset has to be important -- and so does
     everything below that puts a border or a padding back. */
  table.table-sites td { order: 3; border: 0 !important; padding: 0 !important; text-align: left !important; }
  /* A zero-height flex item that ends the first line, so the domain and its tag
     keep it to themselves however short the domain is. Its negative margin
     gives back the row gap the extra line would otherwise add twice. */
  table.table-sites tbody tr::before { content: ""; order: 2; flex: 0 0 100%; height: 0; margin: -7px 0; }
  /* The domain takes the first line, with what the site runs as a tag directly
     after it: the value says "WordPress" on its own, and a heading over it would
     only repeat the column it came from. The App column is the panel's third, so
     the two are put in this order rather than found in it. */
  table.table-sites td.clp-tweaks-domain { order: 0; flex: 0 0 calc(50% - 6px); min-width: 0;
    font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
  table.table-sites td.clp-tweaks-type { order: 1; flex: 0 1 auto; max-width: 45%; margin: 1px 0 0;
    padding: 3px 8px !important; border: 1px solid #eaeaea !important; border-radius: 4px; color: #9bacb6;
    font-size: 12px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  html.dark table.table-sites td.clp-tweaks-type { border-color: var(--clp-border-color) !important; }
  table.table-sites td[data-label] { flex: 1 1 calc(50% - 6px); min-width: 0; }
  table.table-sites td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 4px;
    color: #9bacb6; font-size: 12px; font-weight: 700; text-transform: uppercase; }
  table.table-sites td.clp-tweaks-actions { order: 4; flex: 1 1 100%; }
}
`;

// With both switches on the button belongs on the card's first line, beside
// what the site runs, rather than on a full-width row of its own below it.
const MENU_MOBILE_STYLE = `
@media (max-width: 860px) {
  html.clp-tweaks-menu table.table-sites td.clp-tweaks-actions { order: 1; flex: 0 0 auto;
    margin: 0 0 0 auto; }
}
`;

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
const MENU_STYLE = `
html.clp-tweaks-menu table.table-sites tbody td:last-child > a,
html.clp-tweaks-menu table.table-sites tbody td:last-child > button:not(.clp-tweaks-menu-button) { display: none; }
.clp-tweaks-menu-button { display: inline-flex; align-items: center; justify-content: center; width: 30px;
  height: 30px; padding: 0; border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer;
  font-size: 18px; line-height: 1; }
.clp-tweaks-menu-button:hover,
.clp-tweaks-menu-button[aria-expanded="true"] { background: rgba(127, 143, 153, .18); }
.${ROW_MENU_CLASS} { position: fixed; z-index: 2147483000; min-width: 170px; padding: 6px 0;
  border: 1px solid #eaeaea; border-radius: 6px; background: #fff; box-shadow: 0 8px 28px rgba(0, 0, 0, .16);
  text-align: left; }
.${ROW_MENU_CLASS}[hidden] { display: none; }
/* The links keep whatever the addon that owns them styled them with, which for
   an inline action cell is a margin between one link and the next. In here the
   menu decides the spacing. */
.${ROW_MENU_CLASS} > a,
.${ROW_MENU_CLASS} > button { display: block; width: 100%; margin: 0; padding: 9px 18px; border: 0;
  background: none; color: inherit; font-size: 14px; line-height: 1.4; text-align: left; white-space: nowrap;
  cursor: pointer; }
.${ROW_MENU_CLASS} > a:hover,
.${ROW_MENU_CLASS} > button:hover { background: rgba(127, 143, 153, .14); }
html.dark .${ROW_MENU_CLASS} { border-color: var(--clp-border-color, #a8b3cf33);
  background: var(--clp-bg-secondary, #1c1f26); color: var(--clp-text, #fff); }
`;

// Written for the panel's page, not for an addon page: no shared client code
// reaches here, so this is plain ES5 with its own fetch and its own escaping.
// Everything it writes into a cell goes in as text or as an element it built,
// never as markup, because every value in it came out of somebody's database.
const SITES_SCRIPT = `
(function () {
  // Started here rather than inside the handler below, so the request is in
  // flight while the browser is still parsing the table it describes.
  var wanted = fetch("ADDON_URL/api/panel", {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  })
    .then(function (response) { return response.ok ? response.json() : null; })
    .catch(function () { return null; });

  function start() {
    var table = document.querySelector("table.table-sites");
    var tbody = table && table.querySelector("tbody");
    var toolbar = document.getElementById("clp-tweaks-toolbar");
    if (!table || !tbody || !toolbar) {
      // A page whose markup this no longer recognises keeps its own action
      // links, rather than losing them to a menu that will never be built.
      document.documentElement.classList.remove("clp-tweaks-menu");
      return;
    }

    var rows = [];
    var bodyRows = tbody.querySelectorAll("tr");
    for (var r = 0; r < bodyRows.length; r++) {
      var row = bodyRows[r];
      var link = row.querySelector("td a");
      var domain = link ? link.textContent.trim() : "";
      if (!domain) continue;
      rows.push({ el: row, domain: domain, site: null });
    }
    if (rows.length === 0) return;

    table.classList.add("clp-tweaks-table");
    scroll(table);
    labelNativeCells(rows);
    if (document.documentElement.classList.contains("clp-tweaks-menu")) buildMenus(rows);

    wanted.then(function (payload) {
      if (!payload || payload.ok !== true || !payload.data) return;
      apply(payload.data, rows);
    });

    function apply(data, rows) {
      var tweaks = data.tweaks || {};
      var byDomain = {};
      for (var i = 0; i < data.sites.length; i++) byDomain[data.sites[i].domain] = data.sites[i];
      for (var r = 0; r < rows.length; r++) rows[r].site = byDomain[rows[r].domain] || null;

      nameApplications(rows);
      if (!tweaks.sitesTable) return;
      addColumns(rows, Boolean(tweaks.diskUsage));
      addCount(rows);
      buildToolbar(rows);
      makeSortable(rows);
    }

    // The added columns can outgrow the panel's fixed-width container, and a
    // table that pushes the page sideways takes the heading and the toolbar
    // with it. Scrolling the table alone keeps everything else where it is.
    function scroll(table) {
      var scroller = document.createElement("div");
      scroller.className = "clp-tweaks-scroll";
      table.parentNode.insertBefore(scroller, table);
      scroller.appendChild(table);
    }

    // --- the panel's own four columns ------------------------------------

    function headings() {
      var cells = table.querySelectorAll("thead th");
      var labels = [];
      for (var i = 0; i < cells.length; i++) labels.push(cells[i].textContent.trim());
      return labels;
    }

    // Done before the data arrives, because it needs nothing but the document:
    // a phone gets its labelled cards on the first paint rather than on the
    // reply. The third column is the panel's own App column.
    function labelNativeCells(rows) {
      var labels = headings();
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].el.children;
        for (var c = 0; c < cells.length && c < labels.length; c++) {
          if (c === 0) cells[c].classList.add("clp-tweaks-domain");
          else if (c === cells.length - 1) cells[c].classList.add("clp-tweaks-actions");
          else if (c === 2) cells[c].classList.add("clp-tweaks-type");
          else cells[c].setAttribute("data-label", labels[c]);
        }
      }
    }

    var APPLICATION_NAMES = APPLICATION_LABELS_JSON;

    function applicationName(site) {
      if (!site) return "";
      var name = (site.application || "").trim();
      if (!name) return (site.type || "").trim();
      return APPLICATION_NAMES[name] || name;
    }

    // CloudPanel prints the site's type here, uppercased, so a WordPress reads
    // as PHP and a reverse proxy as REVERSE-PROXY. The application it recorded
    // is both more use and what the filter beside the table offers.
    function nameApplications(rows) {
      for (var i = 0; i < rows.length; i++) {
        var cell = rows[i].el.children[2];
        var name = applicationName(rows[i].site);
        if (cell && name) cell.textContent = name;
      }
    }

    // --- the columns this addon adds -------------------------------------

    function header(label, key, numeric) {
      var th = document.createElement("th");
      th.textContent = label;
      th.className = "clp-tweaks-sortable";
      th.setAttribute("data-sort", key);
      if (numeric) th.setAttribute("data-numeric", "1");
      th.setAttribute("scope", "col");
      th.tabIndex = 0;
      return th;
    }

    function cell(label) {
      var td = document.createElement("td");
      td.setAttribute("data-label", label);
      return td;
    }

    function badge(text, tone, title) {
      var span = document.createElement("span");
      span.className = "clp-tweaks-badge clp-tweaks-" + tone;
      span.textContent = text;
      if (title) span.title = title;
      return span;
    }

    var CERTIFICATE_NAMES = CERTIFICATE_LABELS_JSON;
    var SELF_SIGNED = SELF_SIGNED_JSON;

    function certificateName(type) {
      return CERTIFICATE_NAMES[String(type || "").trim()] || (type ? String(type) : "Certificate");
    }

    function daysUntil(value) {
      if (!value) return null;
      var at = Date.parse(String(value).replace(" ", "T") + "Z");
      if (isNaN(at)) at = Date.parse(value);
      if (isNaN(at)) return null;
      return Math.floor((at - Date.now()) / 86400000);
    }

    // CloudPanel gives every new site a self-signed certificate, so reporting
    // that as covered would mark the whole fleet green. It is named as the
    // placeholder it is; only a certificate a browser accepts counts down.
    function sslCell(site) {
      var td = cell("SSL");
      if (!site || !site.certificate) {
        td.appendChild(badge("None", "none"));
        td.setAttribute("data-value", "0");
        return td;
      }
      var name = certificateName(site.certificate.type);
      if (String(site.certificate.type) === SELF_SIGNED) {
        td.appendChild(badge(name, "none", site.certificate.expiresAt || ""));
        td.setAttribute("data-value", "1");
        return td;
      }
      var left = daysUntil(site.certificate.expiresAt);
      var tone = left !== null && left < 14 ? "warn" : "ok";
      var note = left === null ? name
        : left < 0 ? name + " · expired"
        : name + " · " + left + "d left";
      td.appendChild(badge(note, tone, site.certificate.expiresAt || ""));
      td.setAttribute("data-value", String(left === null ? 2 : left + 100000));
      return td;
    }

    function runtimeCell(site) {
      var td = cell("Runtime");
      var text = site && site.runtime ? site.runtime : "";
      if (text) {
        td.textContent = text;
      } else {
        td.textContent = "—";
        td.className += " clp-tweaks-muted";
      }
      td.setAttribute("data-value", text);
      return td;
    }

    var UNITS = ["B", "KB", "MB", "GB", "TB"];

    function humanBytes(bytes) {
      var size = Number(bytes) || 0;
      var unit = 0;
      while (size >= 1024 && unit < UNITS.length - 1) {
        size = size / 1024;
        unit++;
      }
      return (unit === 0 ? size : size < 10 ? size.toFixed(1) : Math.round(size)) + " " + UNITS[unit];
    }

    function diskCell(site) {
      var td = cell("Disk");
      td.className += " clp-tweaks-size";
      var disk = site && site.disk;
      if (!disk) {
        td.textContent = "—";
        td.title = "Not measured yet. The next sweep runs within fifteen minutes.";
        td.setAttribute("data-value", "-1");
        return td;
      }
      var total = (Number(disk.bytes) || 0) + (Number(disk.databaseBytes) || 0);
      td.textContent = humanBytes(total);
      td.title = "Files " + humanBytes(disk.bytes) +
        (disk.databaseBytes ? " · databases " + humanBytes(disk.databaseBytes) : "") +
        " · measured " + new Date(disk.measuredAt).toLocaleString();
      td.setAttribute("data-value", String(total));
      return td;
    }

    function addColumns(rows, withDisk) {
      var headRow = table.querySelector("thead tr");
      var actionHead = headRow ? headRow.lastElementChild : null;
      if (!headRow || !actionHead) return;
      headRow.insertBefore(header("SSL", "ssl", true), actionHead);
      headRow.insertBefore(header("Runtime", "runtime", false), actionHead);
      if (withDisk) headRow.insertBefore(header("Disk", "disk", true), actionHead);

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var actionCell = row.el.lastElementChild;
        row.el.insertBefore(sslCell(row.site), actionCell);
        row.el.insertBefore(runtimeCell(row.site), actionCell);
        if (withDisk) row.el.insertBefore(diskCell(row.site), actionCell);
      }
    }


    // --- the row menu ------------------------------------------------------

    // The list is put in the body and positioned against the button, because
    // the cell it came from is inside a scroller that would clip it. Every way
    // out of a menu closes it: the button again, a click anywhere else, Escape,
    // a scroll, a resize, or the focus leaving it.
    function buildMenus(rows) {
      var open = null;

      function close() {
        if (!open) return;
        open.list.hidden = true;
        open.button.setAttribute("aria-expanded", "false");
        open = null;
      }

      function place(entry) {
        var rect = entry.button.getBoundingClientRect();
        var list = entry.list;
        list.hidden = false;
        var width = list.offsetWidth;
        var height = list.offsetHeight;
        var room = document.documentElement.clientWidth;
        var left = Math.max(8, Math.min(rect.right - width, room - width - 8));
        var top = rect.bottom + 4;
        if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
        list.style.left = left + "px";
        list.style.top = top + "px";
      }

      function build(row) {
        var cellEl = row.el.lastElementChild;
        if (!cellEl) return;
        var found = cellEl.querySelectorAll("a, button");
        if (found.length === 0) return;
        // An action the owning addon thought too rare for a link in the row is
        // not the first thing in the menu either, whatever order the templates
        // were patched in.
        var actions = [];
        var rare = [];
        for (var f = 0; f < found.length; f++) {
          (found[f].classList.contains("${MENU_ONLY_CLASS}") ? rare : actions).push(found[f]);
        }
        actions = actions.concat(rare);

        var list = document.createElement("div");
        list.className = "${ROW_MENU_CLASS}";
        list.hidden = true;
        for (var i = 0; i < actions.length; i++) list.appendChild(actions[i]);
        document.body.appendChild(list);

        var button = document.createElement("button");
        button.type = "button";
        button.className = "clp-tweaks-menu-button";
        button.setAttribute("aria-haspopup", "true");
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-label", "Actions for " + row.domain);
        button.textContent = "\u22EE";
        cellEl.appendChild(button);

        var entry = { button: button, list: list };
        button.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          var already = open && open.list === list;
          close();
          if (already) return;
          open = entry;
          button.setAttribute("aria-expanded", "true");
          place(entry);
          var first = list.querySelector("a, button");
          if (first) first.focus();
        });
        // Whatever the operator picked is now under way; the menu has no more
        // to say. The event still reaches the document, where the sign-in
        // addon's own listener is waiting for it.
        list.addEventListener("click", function () { close(); });
      }

      for (var r = 0; r < rows.length; r++) build(rows[r]);

      document.addEventListener("click", function (event) {
        if (open && !open.list.contains(event.target)) close();
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" || event.key === "Esc") close();
      });
      document.addEventListener("focusin", function (event) {
        if (open && open.button !== event.target && !open.list.contains(event.target)) close();
      });
      window.addEventListener("resize", close);
      window.addEventListener("scroll", close, true);
    }

    // --- the count beside the heading ------------------------------------

    var counter = null;

    function addCount(rows) {
      var heading = document.querySelector(".page-title h1");
      if (!heading) return;
      counter = document.createElement("span");
      counter.className = "clp-tweaks-count";
      counter.textContent = String(rows.length);
      heading.appendChild(counter);
    }

    function paintCount(shown, total) {
      if (counter) counter.textContent = shown === total ? String(total) : shown + " / " + total;
      var summary = document.getElementById("clp-tweaks-summary");
      if (summary) {
        summary.textContent = shown === total
          ? total + (total === 1 ? " site" : " sites")
          : shown + " of " + total + " sites shown";
      }
    }

    // --- search and filter -----------------------------------------------

    function buildToolbar(rows) {
      var search = document.getElementById("clp-tweaks-search");
      var picker = document.getElementById("clp-tweaks-type");
      if (!search || !picker) return;

      var seen = {};
      var kinds = [];
      for (var i = 0; i < rows.length; i++) {
        var label = applicationName(rows[i].site);
        if (!label || seen[label]) continue;
        seen[label] = true;
        kinds.push(label);
      }
      kinds.sort();
      for (var k = 0; k < kinds.length; k++) {
        var option = document.createElement("option");
        option.value = kinds[k];
        option.textContent = kinds[k];
        picker.appendChild(option);
      }

      var empty = document.createElement("div");
      empty.className = "clp-tweaks-empty";
      empty.textContent = "No site matches that search.";
      empty.hidden = true;
      table.parentNode.insertBefore(empty, table.nextSibling);

      function filter() {
        var needle = search.value.trim().toLowerCase();
        var kind = picker.value;
        var shown = 0;
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var haystack = (row.domain + " " + (row.site ? row.site.user + " " + applicationName(row.site) + " " + row.site.runtime : "")).toLowerCase();
          var visible = (!needle || haystack.indexOf(needle) !== -1) && (!kind || applicationName(row.site) === kind);
          row.el.hidden = !visible;
          if (visible) shown++;
        }
        empty.hidden = shown !== 0;
        paintCount(shown, rows.length);
      }

      search.addEventListener("input", filter);
      picker.addEventListener("change", filter);
      toolbar.hidden = false;
      paintCount(rows.length, rows.length);
    }

    // --- sorting ----------------------------------------------------------

    function sortKey(row, index, numeric) {
      var cells = row.el.children;
      var td = cells[index];
      if (!td) return numeric ? 0 : "";
      var raw = td.hasAttribute("data-value") ? td.getAttribute("data-value") : td.textContent.trim();
      return numeric ? Number(raw) || 0 : raw.toLowerCase();
    }

    function makeSortable(rows) {
      var headCells = table.querySelectorAll("thead th");
      var order = {};
      for (var i = 0; i < headCells.length; i++) {
        var th = headCells[i];
        if (i === headCells.length - 1) continue;
        if (!th.classList.contains("clp-tweaks-sortable")) {
          th.className += " clp-tweaks-sortable";
          th.tabIndex = 0;
        }
        bind(th, i);
      }

      function bind(th, index) {
        function run() {
          var numeric = th.hasAttribute("data-numeric");
          var direction = order[index] === "asc" ? "desc" : "asc";
          order = {};
          order[index] = direction;
          var sign = direction === "asc" ? 1 : -1;
          var sorted = rows.slice().sort(function (a, b) {
            var left = sortKey(a, index, numeric);
            var right = sortKey(b, index, numeric);
            if (left < right) return -sign;
            if (left > right) return sign;
            return a.domain < b.domain ? -1 : 1;
          });
          for (var s = 0; s < sorted.length; s++) tbody.appendChild(sorted[s].el);
          for (var h = 0; h < headCells.length; h++) {
            headCells[h].classList.remove("clp-tweaks-asc");
            headCells[h].classList.remove("clp-tweaks-desc");
          }
          th.classList.add(direction === "asc" ? "clp-tweaks-asc" : "clp-tweaks-desc");
          th.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
        }
        th.addEventListener("click", run);
        th.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            run();
          }
        });
      }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
`;

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
 * only a narrow screen wants. They all carry a `body` in front so that they
 * outrank the manager's block, which the panel renders after this one.
 */
const PANEL_HEADER_STYLE = headerWrapStyle("body .header") + `
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
  /* Bootstrap draws the caret from the font size it inherits, which is the
     page's rather than the avatar's. */
  body .header .navbar-right > ul > li.user-avatar > a.dropdown-toggle::after { border-top-width: 4px;
    border-left-width: 4px; border-right-width: 4px; margin-left: 4px; }
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

function sitesSnippet(url: string, tweaks: PanelTweaks = storedTweaks()): string {
  const style = SITES_STYLE
    + (tweaks.sitesMobile ? SITES_MOBILE_STYLE : "")
    + (tweaks.actionMenu ? MENU_STYLE : "")
    + (tweaks.actionMenu && tweaks.sitesMobile ? MENU_MOBILE_STYLE : "");
  // Set here rather than when the script below runs, so the rule that hides the
  // panel's own action links is already in force when the table is parsed.
  const menuClass = tweaks.actionMenu
    ? `\n          <script>document.documentElement.classList.add("clp-tweaks-menu");</script>`
    : "";
  return `
          {% if is_granted('ROLE_ADMIN') %}
          <style>${style}</style>${menuClass}
          <div class="clp-tweaks-toolbar" id="clp-tweaks-toolbar" hidden>
            <input type="search" id="clp-tweaks-search" class="form-control" placeholder="Search sites" aria-label="Search sites">
            <select id="clp-tweaks-type" class="form-select" aria-label="Filter by application">
              <option value="">All applications</option>
            </select>
            <span class="clp-tweaks-summary" id="clp-tweaks-summary" role="status"></span>
          </div>
          <script>${SITES_SCRIPT.split("ADDON_URL").join(url)
  .replace("CERTIFICATE_LABELS_JSON", JSON.stringify(CERTIFICATE_LABELS))
  .replace("APPLICATION_LABELS_JSON", JSON.stringify(APPLICATION_LABELS))
  .replace("SELF_SIGNED_JSON", JSON.stringify(SELF_SIGNED_CERTIFICATE))}</script>
          {% endif %}`;
}

/** The login page's script, or nothing at all. */
export function deviceThemeSnippet(on: boolean): string {
  return on ? DEVICE_THEME_SCRIPT : "";
}

/** The narrow-screen header rules, or nothing at all. */
export function panelMobileSnippet(on: boolean): string {
  return on ? `<style>${PANEL_HEADER_STYLE}</style>` : "";
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
