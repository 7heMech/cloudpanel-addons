// What Panel Tweaks adds to CloudPanel's own pages.
//
// Two anchors, not seven. Every authenticated tweak -- the count, the search,
// the sorting, the extra columns, the WordPress sign-in -- is one script and
// one toolbar placed above the sites table, which then edits the table it finds
// below it. Patching the heading, the table head, the loop body and the action
// cell separately would have been four more pieces of CloudPanel's markup to
// match exactly, and four more ways for a panel release to stop the addon.
//
// Nothing here decides what is switched on. The script asks the addon for the
// current tweaks along with the site data, so a switch on the addon's page
// takes effect on the next panel page rather than at the next reconciliation.
// The login page is the exception below, and the reason it is separate.

import type { AddonTarget } from "../../../lib/addon-target";
import { CERTIFICATE_LABELS, SELF_SIGNED_CERTIFICATE, readTweaks, DEFAULT_PANEL_TWEAKS_PATHS } from "../action";

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

// Rules for the panel's own table, scoped to the class the script adds, so a
// site list the script never reached keeps CloudPanel's layout exactly.
//
// The narrow-screen half is the same shape lib/app-ui gives an addon's own
// fleet table: the row becomes a block, the domain takes a line of its own, and
// every other cell names its column. CloudPanel's sites table is four columns
// wide and already overflows a phone; this addon adds up to three more.
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
   columns and overflows the 1200px container at seven. The table is also given
   a scroller, so a narrow window scrolls the table rather than the page. */
.clp-tweaks-scroll { overflow-x: auto; }
/* table.table-sites td is what the panel sets this with, so the override
   has to carry the same weight to land. */
table.clp-tweaks-table th, table.clp-tweaks-table td { padding-left: 20px; padding-right: 20px; }
/* Keeps the link whole: a narrow action column used to break it across
   two lines as "WP" and "Login". The cell itself still wraps, because a
   column wide enough never to wrap would push the table past its card. */
.clp-tweaks-wp { margin-left: 0.75rem; white-space: nowrap; }
@media (max-width: 860px) {
  .clp-tweaks-toolbar .clp-tweaks-summary { margin-left: 0; flex-basis: 100%; }
  .clp-tweaks-scroll { overflow-x: visible; }
  .clp-tweaks-table, .clp-tweaks-table tbody, .clp-tweaks-table tr, .clp-tweaks-table td { display: block; }
  .clp-tweaks-table thead { display: none; }
  /* The cells lose their borders as blocks, so the row draws the only rule
     left telling one site from the next. A translucent grey rather than a
     variable, because the panel defines none this could read. */
  .clp-tweaks-table tr { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 14px 12px;
    padding: 16px 20px; border-top: 1px solid rgba(155, 172, 182, .35); }
  .clp-tweaks-table tbody tr:first-child { border-top: 0; }
  .clp-tweaks-table td { border: 0 !important; padding: 0 !important; text-align: left !important; }
  .clp-tweaks-table td.clp-tweaks-domain { flex: 1 1 100%; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
  .clp-tweaks-table td[data-label] { flex: 1 1 calc(50% - 6px); min-width: 0; }
  .clp-tweaks-table td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 4px;
    color: #9bacb6; font-size: 12px; font-weight: 700; text-transform: uppercase; }
  .clp-tweaks-table td.clp-tweaks-actions { flex: 1 1 100%; }
}
`;

// Written for the panel's page, not for an addon page: no shared client code
// reaches here, so this is plain ES5 with its own fetch and its own escaping.
// Everything it writes into a cell goes in as text or as an element it built,
// never as markup, because every value in it came out of somebody's database.
const SITES_SCRIPT = `
(function () {
  function start() {
    var table = document.querySelector("table.table-sites");
    var tbody = table && table.querySelector("tbody");
    var toolbar = document.getElementById("clp-tweaks-toolbar");
    if (!table || !tbody || !toolbar) return;

    fetch("ADDON_URL/api/panel", {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        if (!payload || payload.ok !== true || !payload.data) return;
        apply(payload.data);
      })
      .catch(function () {});

    function apply(data) {
      var tweaks = data.tweaks || {};
      var byDomain = {};
      for (var i = 0; i < data.sites.length; i++) byDomain[data.sites[i].domain] = data.sites[i];

      var rows = [];
      var bodyRows = tbody.querySelectorAll("tr");
      for (var r = 0; r < bodyRows.length; r++) {
        var row = bodyRows[r];
        var link = row.querySelector("td a");
        var domain = link ? link.textContent.trim() : "";
        if (!domain) continue;
        rows.push({ el: row, domain: domain, site: byDomain[domain] || null });
      }
      if (rows.length === 0) return;

      table.classList.add("clp-tweaks-table");
      scroll(table);
      labelNativeCells(rows);
      if (tweaks.wordpressLogin) addWordPressLinks(rows);
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

    function labelNativeCells(rows) {
      var labels = headings();
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].el.children;
        for (var c = 0; c < cells.length && c < labels.length; c++) {
          if (c === 0) cells[c].classList.add("clp-tweaks-domain");
          else if (c === cells.length - 1) cells[c].classList.add("clp-tweaks-actions");
          else cells[c].setAttribute("data-label", labels[c]);
        }
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

    function typeLabel(site) {
      if (!site) return "";
      return site.application || site.type || "";
    }

    function buildToolbar(rows) {
      var search = document.getElementById("clp-tweaks-search");
      var picker = document.getElementById("clp-tweaks-type");
      if (!search || !picker) return;

      var seen = {};
      var kinds = [];
      for (var i = 0; i < rows.length; i++) {
        var label = typeLabel(rows[i].site);
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
          var haystack = (row.domain + " " + (row.site ? row.site.user + " " + typeLabel(row.site) + " " + row.site.runtime : "")).toLowerCase();
          var visible = (!needle || haystack.indexOf(needle) !== -1) && (!kind || typeLabel(row.site) === kind);
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

    // --- the WordPress sign-in -------------------------------------------

    function csrf() {
      var match = document.cookie.match(/(?:^|;\\s*)clp_addons_csrf=([^;]+)/);
      return match ? match[1] : "";
    }

    function addWordPressLinks(rows) {
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row.site || !row.site.wordpress) continue;
        var cell = row.el.lastElementChild;
        if (!cell) continue;
        var link = document.createElement("a");
        link.href = "#";
        link.className = "clp-tweaks-wp";
        link.textContent = "WP Login";
        link.title = "Sign in to WordPress as its first administrator";
        bindLogin(link, row.domain);
        cell.appendChild(link);
      }
    }

    function bindLogin(link, domain) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        if (link.dataset.busy === "1") return;
        link.dataset.busy = "1";
        // Opened inside the click, before anything is awaited: a window opened
        // after a fetch resolves is a popup the browser blocks.
        var target = window.open("", "_blank");
        fetch("ADDON_URL/api/wp-login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CLP-Addons-CSRF": csrf(), Accept: "application/json" },
          body: JSON.stringify({ domain: domain })
        })
          .then(function (response) { return response.json(); })
          .then(function (payload) {
            if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || "sign-in unavailable");
            submit(target, payload.data);
          })
          .catch(function (error) {
            if (target) target.close();
            alert("WordPress sign-in failed: " + error.message);
          })
          .finally(function () { link.dataset.busy = "0"; });
      });
    }

    // Posted rather than put in the address bar: a single-use secret in a query
    // string is still a secret in the site's access log and in the browser's
    // history.
    function submit(target, data) {
      if (!target) {
        alert("Allow pop-ups for the panel to open WordPress.");
        return;
      }
      var form = target.document.createElement("form");
      form.method = "POST";
      form.action = data.url;
      var field = target.document.createElement("input");
      field.type = "hidden";
      field.name = data.field;
      field.value = data.token;
      form.appendChild(field);
      target.document.body.appendChild(form);
      form.submit();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
`;

function sitesSnippet(url: string): string {
  return `
          {% if is_granted('ROLE_ADMIN') %}
          <style>${SITES_STYLE}</style>
          <div class="clp-tweaks-toolbar" id="clp-tweaks-toolbar" hidden>
            <input type="search" id="clp-tweaks-search" class="form-control" placeholder="Search sites" aria-label="Search sites">
            <select id="clp-tweaks-type" class="form-select" aria-label="Filter by application">
              <option value="">All applications</option>
            </select>
            <span class="clp-tweaks-summary" id="clp-tweaks-summary" role="status"></span>
          </div>
          <script>${SITES_SCRIPT.split("ADDON_URL").join(url).replace("CERTIFICATE_LABELS_JSON", JSON.stringify(CERTIFICATE_LABELS))
  .replace("SELF_SIGNED_JSON", JSON.stringify(SELF_SIGNED_CERTIFICATE))}</script>
          {% endif %}`;
}

/** The login page's script, or nothing at all. */
export function deviceThemeSnippet(on: boolean): string {
  return on ? DEVICE_THEME_SCRIPT : "";
}

/**
 * Whether the login page's script is wanted, read at the moment the templates
 * are rendered -- which is root work, and the only place the stored tweaks can
 * be read from. An empty snippet still leaves its marker pair behind, which is
 * what lets the next reconciliation notice the switch moved back.
 */
function deviceThemeWanted(): boolean {
  try {
    return readTweaks(DEFAULT_PANEL_TWEAKS_PATHS).deviceTheme;
  } catch {
    // Unreadable state is the default state, and the default is on.
    return true;
  }
}

export const SITES_TEMPLATE = "Frontend/Site/index.html.twig";

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
    snippet: () => deviceThemeSnippet(deviceThemeWanted()),
  },
  {
    slug: "sites-table",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: '<div class="card card-table">',
    // Not required: a CloudPanel release that renames this card should cost the
    // sites table its enhancements, not stop the addon -- and with it the login
    // theme -- from being enabled at all.
    required: false,
    snippet: sitesSnippet,
  },
];
