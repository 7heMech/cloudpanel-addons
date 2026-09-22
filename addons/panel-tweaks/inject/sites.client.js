
(function () {
  // Started here rather than inside the handler below, so the request is in
  // flight while the browser is still parsing the table it describes.
  var wanted = fetch("ADDON_URL/api/panel", {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  })
    .then(function (response) { return response.ok ? response.json() : null; })
    .catch(function () { return null; });

  // --- which columns are on ---------------------------------------------
  //
  // A phone has room for two values beside each other, and which two is a
  // question about this screen rather than about the box: the answer is kept
  // per browser, and a narrow screen keeps a different one from a wide one, so
  // a desktop losing the runtime column is not a phone's decision. What a
  // column costs is the same either way -- every one of them is in the reply
  // the table is painted from already.
  var COLUMNS = [
    { key: "user", label: "Site user", wide: true, narrow: false, native: 2 },
    { key: "app", label: "Application", wide: true, narrow: false, native: 3 },
    { key: "ssl", label: "SSL", wide: true, narrow: true },
    { key: "runtime", label: "Runtime", wide: true, narrow: false },
    { key: "disk", label: "Disk", wide: true, narrow: true },
    { key: "created", label: "Created", wide: false, narrow: false },
    { key: "cloudflare", label: "Cloudflare", wide: false, narrow: false },
    { key: "varnish", label: "Varnish", wide: false, narrow: false }
  ];
  var NARROW_QUERY = "(max-width: 860px)";
  var COLUMNS_ON = SITES_TABLE_JSON;
  var columnStyle = null;
  var tagged = false;
  var chosen = {};

  function narrowNow() {
    return Boolean(window.matchMedia && window.matchMedia(NARROW_QUERY).matches);
  }

  function storeKey(narrow) {
    return narrow ? "clp_tweaks_columns_narrow" : "clp_tweaks_columns_wide";
  }

  // The defaults are what a column is worth on a screen that size, and only the
  // keys somebody moved are stored, so a column added by a later release
  // arrives at its own default rather than switched off by an old answer.
  function readChoice(narrow) {
    var picked = {};
    for (var i = 0; i < COLUMNS.length; i++) {
      picked[COLUMNS[i].key] = narrow ? COLUMNS[i].narrow : COLUMNS[i].wide;
    }
    try {
      var saved = JSON.parse(window.localStorage.getItem(storeKey(narrow)) || "{}");
      for (var key in saved) {
        if (Object.prototype.hasOwnProperty.call(picked, key)) picked[key] = saved[key] === true;
      }
    } catch (e) {}
    return picked;
  }

  function writeChoice(narrow, picked) {
    try {
      window.localStorage.setItem(storeKey(narrow), JSON.stringify(picked));
    } catch (e) {}
  }

  // One rule sheet rather than an attribute on every cell: this runs while the
  // browser is still parsing the table, so a column that is off is never
  // painted at all. Until the cells are named, the panel's own two are hidden
  // by their position, which is the only thing about them known this early; the
  // sheet is written again without those rules as soon as they are named.
  function paintColumns(picked) {
    var css = "";
    for (var i = 0; i < COLUMNS.length; i++) {
      var column = COLUMNS[i];
      if (picked[column.key] !== false) continue;
      css += 'table.table-sites [data-col="' + column.key + '"] { display: none !important; }\n';
      if (!tagged && column.native) {
        css += "table.table-sites tr > :nth-child(" + column.native + ") { display: none !important; }\n";
      }
    }
    if (!columnStyle) {
      columnStyle = document.createElement("style");
      (document.head || document.documentElement).appendChild(columnStyle);
    }
    columnStyle.textContent = css;
  }

  if (COLUMNS_ON) {
    chosen = readChoice(narrowNow());
    paintColumns(chosen);
  }

  function start() {
    var table = document.querySelector("table.table-sites");
    var tbody = table && table.querySelector("tbody");
    var toolbar = document.getElementById("clp-tweaks-toolbar");
    if (!table || !tbody || !toolbar) {
      // A page whose markup this no longer recognises keeps its own action
      // links, rather than losing them to a menu that will never be built.
      document.documentElement.classList.remove("clp-tweaks-menu");
      if (toolbar) toolbar.hidden = true;
      return;
    }

    var rows = [];
    function noToolbar() { toolbar.hidden = true; }
    var bodyRows = tbody.querySelectorAll("tr");
    for (var r = 0; r < bodyRows.length; r++) {
      var row = bodyRows[r];
      var link = row.querySelector("td a");
      var domain = link ? link.textContent.trim() : "";
      if (!domain) continue;
      rows.push({ el: row, domain: domain, site: null });
    }
    if (rows.length === 0) return noToolbar();

    table.classList.add("clp-tweaks-table");
    scroll(table);
    labelNativeCells(rows);
    copyDetails(rows);
    if (COLUMNS_ON) {
      tagged = true;
      paintColumns(chosen);
    }
    placeTypes(rows);
    var pendingTypePlacement = null;
    window.addEventListener("resize", function () {
      if (pendingTypePlacement) cancelAnimationFrame(pendingTypePlacement);
      pendingTypePlacement = requestAnimationFrame(function () {
        pendingTypePlacement = null;
        placeTypes(rows);
      });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { placeTypes(rows); });
    if (document.documentElement.classList.contains("clp-tweaks-menu")) buildMenus(rows);

    wanted.then(function (payload) {
      if (!payload || payload.ok !== true || !payload.data) return noToolbar();
      apply(payload.data, rows);
    });

    function apply(data, rows) {
      var tweaks = data.tweaks || {};
      var byDomain = {};
      for (var i = 0; i < data.sites.length; i++) byDomain[data.sites[i].domain] = data.sites[i];
      for (var r = 0; r < rows.length; r++) rows[r].site = byDomain[rows[r].domain] || null;

      nameApplications(rows);
      if (!tweaks.sitesTable) { placeTypes(rows); return noToolbar(); }
      addColumns(rows, Boolean(tweaks.diskUsage));
      copyDetails(rows);
      placeTypes(rows);
      addCount(rows);
      buildToolbar(rows);
      buildColumnPicker(Boolean(tweaks.diskUsage));
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
      var heads = table.querySelectorAll("thead th");
      // The panel's own two middle columns answer to the picker as well, so
      // they are named here with the keys it knows them by. The third is headed
      // Application rather than the panel's own App, which is what the picker calls
      // it, and on a phone it is the tag beside the hostname.
      if (heads[1]) heads[1].setAttribute("data-col", "user");
      if (heads[2]) {
        heads[2].setAttribute("data-col", "app");
        if (COLUMNS_ON) heads[2].textContent = "Application";
      }
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].el.children;
        for (var c = 0; c < cells.length && c < labels.length; c++) {
          if (c === 0) cells[c].classList.add("clp-tweaks-domain");
          else if (c === cells.length - 1) cells[c].classList.add("clp-tweaks-actions");
          else if (c === 2) { cells[c].classList.add("clp-tweaks-type"); cells[c].setAttribute("data-col", "app"); }
          else {
            cells[c].setAttribute("data-label", labels[c]);
            if (c === 1) cells[c].setAttribute("data-col", "user");
          }
        }
        // Keep the native column for the desktop table. The mobile copy moves
        // between the hostname and a detail heading without moving either.
        if (!cells[2]) continue;
        var tag = document.createElement("span");
        tag.className = "clp-tweaks-mobile-type";
        tag.setAttribute("data-col", "app");
        tag.textContent = cells[2].textContent;
        cells[0].appendChild(tag);
      }
    }

    // A single mobile group keeps the detail columns aligned across the full
    // card width. Copy only data; the hostname link and controls stay live.
    function copyDetails(rows) {
      for (var i = 0; i < rows.length; i++) {
        var domain = rows[i].el.querySelector(".clp-tweaks-domain");
        var group = domain.querySelector(".clp-tweaks-details");
        var tag = domain.querySelector(".clp-tweaks-mobile-type");
        if (!group) {
          group = document.createElement("div");
          group.className = "clp-tweaks-details";
          domain.appendChild(group);
        }
        // A previous placement may have put Application inside a heading that is
        // about to be rebuilt.
        if (tag && group.contains(tag)) domain.insertBefore(tag, group);
        group.textContent = "";
        var cells = rows[i].el.querySelectorAll("td[data-label]");
        for (var c = 0; c < cells.length; c++) {
          var copy = document.createElement("div");
          copy.className = cells[c].className;
          copy.setAttribute("data-label", cells[c].getAttribute("data-label"));
          copy.setAttribute("data-col", cells[c].getAttribute("data-col"));
          if (cells[c].title) copy.title = cells[c].title;
          var heading = document.createElement("div");
          heading.className = "clp-tweaks-detail-heading";
          var label = document.createElement("span");
          label.className = "clp-tweaks-detail-label";
          label.textContent = cells[c].getAttribute("data-label");
          heading.appendChild(label);
          copy.appendChild(heading);
          var value = document.createElement("div");
          value.className = "clp-tweaks-detail-value";
          for (var n = 0; n < cells[c].childNodes.length; n++) value.appendChild(cells[c].childNodes[n].cloneNode(true));
          copy.appendChild(value);
          group.appendChild(copy);
        }
      }
    }

    // Application never receives a width and never makes the hostname or metadata
    // columns narrower. It uses the hostname row only when both full values fit
    // there; otherwise it moves into the spare end of the right detail heading.
    function placeTypes(rows) {
      var narrow = Boolean(window.matchMedia && window.matchMedia(NARROW_QUERY).matches);
      for (var i = 0; i < rows.length; i++) {
        var domain = rows[i].el.querySelector(".clp-tweaks-domain");
        var host = domain && domain.querySelector("a");
        var tag = domain && domain.querySelector(".clp-tweaks-mobile-type");
        var group = domain && domain.querySelector(".clp-tweaks-details");
        if (!domain || !host || !tag || !group) continue;
        domain.classList.remove("clp-tweaks-type-at-host");
        domain.classList.remove("clp-tweaks-type-beside-last-host-line");
        tag.classList.remove("clp-tweaks-type-in-empty-field");
        domain.insertBefore(tag, group);
        tag.title = tag.textContent.trim();
        if (!narrow || window.getComputedStyle(tag).display === "none") continue;

        var range = document.createRange();
        range.selectNodeContents(host);
        var lines = range.getClientRects();
        var hostWidth = lines.length === 1 ? lines[0].width : Infinity;
        var tagWidth = tag.getBoundingClientRect().width;
        if (hostWidth + tagWidth + 4 <= domain.clientWidth) {
          domain.classList.add("clp-tweaks-type-at-host");
          continue;
        }
        var domainRect = domain.getBoundingClientRect();
        if (lines.length === 2 && lines[1].right + 4 <= domainRect.right - tagWidth) {
          domain.classList.add("clp-tweaks-type-beside-last-host-line");
        }

        var fields = group.children;
        var visible = [];
        for (var f = 0; f < fields.length; f++) {
          if (fields[f].getClientRects().length) visible.push(fields[f]);
        }
        if (visible.length > 1) {
          var heading = visible[1].querySelector(".clp-tweaks-detail-heading");
          if (heading) heading.appendChild(tag);
        } else {
          tag.classList.add("clp-tweaks-type-in-empty-field");
          group.appendChild(tag);
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
        var tag = rows[i].el.querySelector(".clp-tweaks-mobile-type");
        if (tag && name) tag.textContent = name;
      }
    }

    // --- the columns this addon adds -------------------------------------

    function header(label, key, numeric) {
      var th = document.createElement("th");
      th.textContent = label;
      th.className = "clp-tweaks-sortable";
      th.setAttribute("data-sort", key);
      th.setAttribute("data-col", key);
      if (numeric) th.setAttribute("data-numeric", "1");
      th.setAttribute("scope", "col");
      th.tabIndex = 0;
      return th;
    }

    function cell(label, key) {
      var td = document.createElement("td");
      td.setAttribute("data-label", label);
      td.setAttribute("data-col", key);
      return td;
    }

    function badge(text, tone, title, detail, compact) {
      var span = document.createElement("span");
      span.className = "clp-tweaks-badge clp-tweaks-" + tone;
      if (detail) {
        span.classList.add("clp-tweaks-badge-timed");
        var full = document.createElement("span");
        full.className = "clp-tweaks-badge-full";
        full.textContent = text + " · " + detail;
        span.appendChild(full);
        var short = document.createElement("span");
        short.className = "clp-tweaks-badge-compact";
        short.setAttribute("aria-hidden", "true");
        short.textContent = compact;
        span.appendChild(short);
      } else span.textContent = text;
      if (title) span.title = title;
      return span;
    }

    var CERTIFICATE_NAMES = CERTIFICATE_LABELS_JSON;
    var CERTIFICATE_SHORT_NAMES = CERTIFICATE_SHORT_LABELS_JSON;
    var SELF_SIGNED = SELF_SIGNED_JSON;

    function certificateName(type) {
      return CERTIFICATE_NAMES[String(type || "").trim()] || (type ? String(type) : "Certificate");
    }

    function shortCertificateName(type) {
      return CERTIFICATE_SHORT_NAMES[String(type || "").trim()] || "";
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
    // placeholder it is; only a certificate a browser accepts counts down. An
    // origin certificate runs for years rather than months, and a four-digit
    // day count reads as noise, so a long one counts down in years.
    function sslCell(site) {
      var td = cell("SSL", "ssl");
      if (!site || !site.certificate) {
        td.appendChild(badge("None", "none"));
        td.setAttribute("data-value", "0");
        return td;
      }
      // An imported certificate arrives with the name it was issued under,
      // which is the only one the panel's own wording cannot tell apart.
      var name = site.certificate.issuer || certificateName(site.certificate.type);
      if (String(site.certificate.type) === SELF_SIGNED) {
        td.appendChild(badge(name, "none", site.certificate.expiresAt || ""));
        td.setAttribute("data-value", "1");
        return td;
      }
      var left = daysUntil(site.certificate.expiresAt);
      var tone = left !== null && left < 14 ? "warn" : "ok";
      var counted = left < 0 ? "expired" : left >= 730 ? Math.floor(left / 365) + "y" : left + "d";
      var note = left === null ? "" : left < 0 ? "expired" : counted + " left";
      var short = site.certificate.issuer || shortCertificateName(site.certificate.type);
      td.appendChild(badge(name, tone, site.certificate.expiresAt || "", note,
        short ? short + " · " + counted : counted));
      td.setAttribute("data-value", String(left === null ? 2 : left + 100000));
      return td;
    }

    function runtimeCell(site) {
      var td = cell("Runtime", "runtime");
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
      var td = cell("Disk", "disk");
      td.className += " clp-tweaks-size";
      var disk = site && site.disk;
      if (!disk) {
        td.textContent = "—";
        td.title = "Not measured yet. Use Measure now, or wait for the next scheduled sweep.";
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

    // CloudPanel writes its timestamps in UTC without saying so, the way
    // SQLite does: "2026-09-10 09:30:00". The cell shows the date in the
    // reader's own zone and sorts on the instant behind it.
    function createdAtOf(site) {
      if (!site || !site.createdAt) return NaN;
      var at = Date.parse(String(site.createdAt).replace(" ", "T") + "Z");
      return isNaN(at) ? Date.parse(site.createdAt) : at;
    }

    function createdCell(site) {
      var td = cell("Created", "created");
      var at = createdAtOf(site);
      if (isNaN(at)) {
        td.textContent = "—";
        td.className += " clp-tweaks-muted";
        td.setAttribute("data-value", "0");
        return td;
      }
      td.textContent = new Date(at).toLocaleDateString();
      td.title = new Date(at).toLocaleString();
      td.setAttribute("data-value", String(at));
      return td;
    }

    // Two of the panel's own per-site switches. They are modes rather than
    // problems, so neither is coloured as one: what an operator wants from a
    // column of them is to see which sites are unlike the rest.
    function switchCell(label, key, on) {
      var td = cell(label, key);
      if (on) {
        td.textContent = "On";
        td.setAttribute("data-value", "1");
        return td;
      }
      td.textContent = "—";
      td.className += " clp-tweaks-muted";
      td.setAttribute("data-value", "0");
      return td;
    }

    // Every column is built for every row, whether or not it is switched on:
    // what hides one is a rule keyed on its name, so the picker turns a column
    // back on without the table being built again.
    function addColumns(rows, withDisk) {
      var headRow = table.querySelector("thead tr");
      var actionHead = headRow ? headRow.lastElementChild : null;
      if (!headRow || !actionHead) return;
      headRow.insertBefore(header("SSL", "ssl", true), actionHead);
      headRow.insertBefore(header("Runtime", "runtime", false), actionHead);
      if (withDisk) headRow.insertBefore(header("Disk", "disk", true), actionHead);
      headRow.insertBefore(header("Created", "created", true), actionHead);
      headRow.insertBefore(header("Cloudflare", "cloudflare", true), actionHead);
      headRow.insertBefore(header("Varnish", "varnish", true), actionHead);

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var actionCell = row.el.lastElementChild;
        row.el.insertBefore(sslCell(row.site), actionCell);
        row.el.insertBefore(runtimeCell(row.site), actionCell);
        if (withDisk) row.el.insertBefore(diskCell(row.site), actionCell);
        row.el.insertBefore(createdCell(row.site), actionCell);
        row.el.insertBefore(switchCell("Cloudflare", "cloudflare", row.site && row.site.cloudflareOnly), actionCell);
        row.el.insertBefore(switchCell("Varnish", "varnish", row.site && row.site.varnish), actionCell);
      }
    }

    // --- the column picker -------------------------------------------------

    // Checking a box is not a submission: it paints the table again and is
    // remembered for this browser, so the menu stays open for the next one.
    // Closing it is the button again, a click outside it, or Escape.
    function buildColumnPicker(withDisk) {
      var holder = document.getElementById("clp-tweaks-columns");
      var button = document.getElementById("clp-tweaks-columns-button");
      var menu = document.getElementById("clp-tweaks-columns-menu");
      if (!holder || !button || !menu) return;

      var boxes = [];
      for (var i = 0; i < COLUMNS.length; i++) {
        var column = COLUMNS[i];
        if (column.key === "disk" && !withDisk) continue;
        var label = document.createElement("label");
        var box = document.createElement("input");
        box.type = "checkbox";
        box.checked = chosen[column.key] !== false;
        box.setAttribute("data-column", column.key);
        label.appendChild(box);
        label.appendChild(document.createTextNode(column.label));
        menu.appendChild(label);
        boxes.push(box);
        bindBox(box, column.key);
      }

      function bindBox(box, key) {
        box.addEventListener("change", function () {
          chosen[key] = box.checked;
          writeChoice(narrowNow(), chosen);
          paintColumns(chosen);
          placeTypes(rows);
        });
      }

      function close() {
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
      }

      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        var open = !menu.hidden;
        menu.hidden = open;
        button.setAttribute("aria-expanded", open ? "false" : "true");
      });
      document.addEventListener("click", function (event) {
        if (!menu.hidden && !holder.contains(event.target)) close();
      });
      document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape" && event.key !== "Esc") return;
        if (menu.hidden) return;
        // Taken back only from inside the menu, so Escape pressed elsewhere on
        // the page does not pull focus to this button.
        var inside = holder.contains(document.activeElement);
        close();
        if (inside) button.focus();
      });

      // A window dragged across the breakpoint is a different screen with a
      // different answer, so the other one is read back and the boxes follow.
      if (window.matchMedia) {
        var query = window.matchMedia(NARROW_QUERY);
        var moved = function () {
          chosen = readChoice(query.matches);
          for (var b = 0; b < boxes.length; b++) {
            boxes[b].checked = chosen[boxes[b].getAttribute("data-column")] !== false;
          }
          paintColumns(chosen);
          placeTypes(rows);
        };
        if (query.addEventListener) query.addEventListener("change", moved);
        else if (query.addListener) query.addListener(moved);
      }

      holder.hidden = false;
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
        // The panel's own actions first, then what the addons added, then the
        // ones an addon thought too rare for a link in the row at all --
        // whatever order the templates were patched in.
        var native = [];
        var added = [];
        var rare = [];
        for (var f = 0; f < found.length; f++) {
          var link = found[f];
          if (link.classList.contains("MENU_ONLY_CLASS")) rare.push(link);
          else if (link.classList.contains("ROW_ACTION_CLASS")) added.push(link);
          else native.push(link);
        }
        var actions = native.concat(added, rare);

        var list = document.createElement("div");
        list.className = "ROW_MENU_CLASS";
        list.hidden = true;
        for (var i = 0; i < actions.length; i++) list.appendChild(actions[i]);
        document.body.appendChild(list);

        var button = document.createElement("button");
        button.type = "button";
        button.className = "clp-tweaks-menu-button";
        button.setAttribute("aria-haspopup", "true");
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-label", "Actions for " + row.domain);
        button.textContent = "⋮";
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
        if (event.key !== "Escape" && event.key !== "Esc") return;
        if (!open) return;
        // Opening put focus on the first item in the menu, so closing has to
        // hand it back rather than leave it on what is now hidden.
        var opener = open.button;
        close();
        opener.focus();
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
      // The hostname cell also carries the mobile type label.
      if (index === 0) return row.domain.toLowerCase();
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
            headCells[h].removeAttribute("aria-sort");
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
