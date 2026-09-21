import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileNewSites, runCloudflareAction, transformVhost, type CloudflareActionPaths,
} from "../addons/cloudflare-ips/action";
import { CLIENT_JS, dashboardView, layout } from "../addons/cloudflare-ips/app/views";
import type { CommandResult } from "../cli/action-common";

const realUid = process.getuid?.() ?? 0;
const originalGetuid = process.getuid;

beforeEach(() => {
  Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "getuid", { value: originalGetuid, configurable: true });
});

function vhost(user: string): string {
  return `server {
  listen 443 ssl;
  server_name example.test;
  access_log /home/${user}/logs/nginx/access.log main;
  error_log /home/${user}/logs/nginx/error.log;
  location / { try_files $uri =404; }
}
`;
}

function fixture(): { root: string; paths: CloudflareActionPaths; db: Database } {
  const root = mkdtempSync(join(tmpdir(), "cloudflare-ips-test-"));
  const nginxVhostDir = join(root, "vhosts");
  mkdirSync(nginxVhostDir);
  const panelDb = join(root, "panel.sqlite");
  const db = new Database(panelDb);
  db.exec(`CREATE TABLE site (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_name TEXT UNIQUE NOT NULL,
    user TEXT NOT NULL,
    type TEXT NOT NULL,
    allow_traffic_from_cloudflare_only INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  return {
    root,
    db,
    paths: {
      panelDb,
      nginxVhostDir,
      policyFile: join(root, "state", "policy.json"),
      lockFile: join(root, "locks", "cloudflare.lock"),
      nginx: "nginx-test",
      systemctl: "systemctl-test",
      vhostUid: realUid,
      stateUid: realUid,
    },
  };
}

function addSite(db: Database, paths: CloudflareActionPaths, domain: string, user: string, enabled = false): number {
  db.query("INSERT INTO site (domain_name, user, type, allow_traffic_from_cloudflare_only) VALUES (?, ?, 'php', ?);")
    .run(domain, user, enabled ? 1 : 0);
  const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id;").get()!.id);
  const file = join(paths.nginxVhostDir, `${domain}.conf`);
  writeFileSync(file, transformVhost(vhost(user), user, enabled), { mode: 0o644 });
  chmodSync(file, 0o644);
  return id;
}

const successCommand = (): CommandResult => ({ ok: true, stdout: "", stderr: "", exitCode: 0 });

async function captureActionFailure(action: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await action(), stderr };
  } finally {
    process.stderr.write = originalWrite;
  }
}

test("dashboard renders bulk, per-site, and automatic controls with escaped site data", () => {
  const html = dashboardView({
    autoEnableNewSites: true,
    sites: [{ domain: '"><script>alert(1)</script>.example.test', type: "php", enabled: false, excludedFromAutomatic: true }],
  });
  expect(html).toContain("Enable all sites");
  expect(html).toContain("Disable all sites");
  expect(html).toContain("Enable selected");
  expect(html).toContain('id="select-all"');
  expect(html).toContain('id="automatic-policy"');
  expect(html).toContain('tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)"');
  expect(html).toContain("This never changes a site that already exists.");
  expect(html).not.toContain("A site turned off above stays excluded.");
  expect(html).not.toContain("Excluded from automatic enabling");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(() => new Function(CLIENT_JS)).not.toThrow();
});

test("dashboard summarises how many sites allow Cloudflare only", () => {
  const sites = [
    { domain: "a.example.test", type: "php", enabled: true, excludedFromAutomatic: false },
    { domain: "b.example.test", type: "php", enabled: false, excludedFromAutomatic: true },
    { domain: "c.example.test", type: "static", enabled: true, excludedFromAutomatic: false },
  ];
  expect(dashboardView({ autoEnableNewSites: true, sites })).toContain("2 of 3 sites allow Cloudflare only.");
  expect(dashboardView({ autoEnableNewSites: true, sites: [] })).toContain("No sites found in CloudPanel.");
  // Selected-scope actions start unavailable because nothing is selected yet.
  const rendered = dashboardView({ autoEnableNewSites: true, sites });
  expect(rendered).toContain('id="enable-selected" type="button" disabled');
  expect(rendered).toContain('id="disable-selected" type="button" disabled');
  expect(rendered).toContain('<div class="actions toolbar-actions">');
});

test("the switch column ends where the table ends, as the Maintenance table does", () => {
  const state = {
    autoEnableNewSites: true,
    sites: [{ domain: "a.example.test", type: "php", enabled: true, excludedFromAutomatic: false }],
  };
  const html = dashboardView(state);
  // .action-cell is the shared right-aligned column; without it the switches
  // sat in the middle of the row with the rest of the table empty beside them.
  expect(html).toContain('<th scope="col" class="action-cell">Cloudflare only</th>');
  expect(html).toContain('<td class="action-cell" data-label="Cloudflare only">');
  expect(html).toContain('<table class="fleet-table inline-mobile-type cloudflare-site-table">');
  expect(html).toContain('<span class="mobile-site-type">PHP</span>');
  // On a phone this is the only action, so it stays in the site's summary row
  // and does not repeat the desktop column heading in every card.
  const page = layout("Cloudflare IP access", html);
  expect(page).toContain(".fleet-table.inline-mobile-type .mobile-site-type { display: inline-block;");
  // The hostname is the thing being read, so it is set smaller to fit and the
  // badge beside it is trimmed rather than pushing it around.
  expect(page).toContain(".fleet-table.inline-mobile-type td.site-cell { font-size: 14px; }");
  expect(page).toContain("max-width: 40%;");
  expect(page).toContain("grid-template-columns: minmax(0, 1fr) 50px;");
  expect(page).toContain(".fleet-table.cloudflare-site-table td.site-select { display: none; }");
  expect(page).toContain(".cloudflare-site-table td.action-cell::before { display: none; }");
  expect(page).toContain(".cloudflare-site-table td.action-cell { display: flex; align-self: center;");
});

interface FakeElement {
  textContent: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  indeterminate: boolean;
  closest?: (selector: string) => unknown;
}

interface FakeRow {
  dataset: { domain: string; enabled: string; excluded: string };
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  querySelector: (selector: string) => FakeElement | null;
  parts: { checkbox: FakeElement; toggle: FakeElement };
}

/**
 * Just enough DOM for the dashboard's own script: the rows it counts, the
 * controls it enables and the labels it repaints. Kept here rather than pulled
 * in as a browser environment because these tests are about the addon's rules,
 * not about rendering.
 */
function fakeDashboard(
  sites: { domain: string; enabled: boolean; excluded: boolean; selected?: boolean }[],
  auto = true,
) {
  const el = (over: Partial<FakeElement> = {}): FakeElement => ({
    textContent: "", className: "", hidden: false, disabled: false, checked: false, indeterminate: false, ...over,
  });
  const byId: Record<string, FakeElement> = {
    "cf-summary": el(), "cf-selection": el(), "select-all": el(), "select-all-btn": el(),
    "enable-selected": el({ disabled: true }), "disable-selected": el({ disabled: true }),
    "enable-all": el(), "disable-all": el(),
    "automatic-policy": el({ checked: auto }),
  };
  const rows: FakeRow[] = sites.map((site) => {
    const attributes: Record<string, string> = { "aria-selected": "false" };
    const parts = {
      checkbox: el({ checked: Boolean(site.selected) }),
      toggle: el({ checked: site.enabled }),
    };
    const row: FakeRow = {
      dataset: { domain: site.domain, enabled: String(site.enabled), excluded: String(site.excluded) },
      attributes,
      setAttribute: (name, value) => { attributes[name] = value; },
      querySelector: (selector) => ({
        ".site-checkbox": parts.checkbox, ".site-switch": parts.toggle,
      }[selector] ?? null),
      parts,
    };
    parts.checkbox.closest = parts.toggle.closest = (selector) => (selector === "tr[data-domain]" ? row : null);
    return row;
  });
  const document = {
    readyState: "complete",
    addEventListener() {},
    getElementById: (id: string) => byId[id] ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === "tr[data-domain]") return rows;
      if (selector === ".site-checkbox") return rows.map((row) => row.parts.checkbox);
      return [];
    },
  };
  return { document, rows, byId };
}

interface DashboardClient {
  setOne(input: unknown): Promise<void>;
  setAllSites(enabled: boolean): void;
  runBulk(rows: unknown[], enabled: boolean, scope: string): Promise<void>;
  siteRows(): unknown[];
  rowState(row: unknown): unknown;
  paintSummary(): void;
  toggleAllSites(): void;
  selectAllSites(checked: boolean): void;
  toggleSiteSelection(event: unknown, row: unknown): void;
}

function loadDashboard(
  dom: ReturnType<typeof fakeDashboard>,
  handlers: {
    call: (path: string, options?: unknown) => Promise<unknown>;
    confirmAction?: (options: { details?: string[] }) => Promise<boolean>;
    notify?: (message: string, kind: string) => void;
    busy?: (on: boolean) => void;
    reload?: () => void;
  },
): DashboardClient {
  const factory = new Function(
    "document", "call", "busy", "notify", "clearNotice", "confirmAction", "location",
    `${CLIENT_JS}\nreturn { setOne, setAllSites, runBulk, siteRows, rowState, paintSummary, toggleAllSites, selectAllSites, toggleSiteSelection };`,
  ) as (...args: unknown[]) => DashboardClient;
  return factory(
    dom.document,
    handlers.call,
    handlers.busy ?? (() => {}),
    handlers.notify ?? (() => {}),
    () => {},
    handlers.confirmAction ?? (async () => true),
    { reload: handlers.reload ?? (() => {}) },
  );
}

test("a failed per-site update reports inline and repaints from the server", async () => {
  const dom = fakeDashboard([{ domain: "retry.example.test", enabled: false, excluded: true }]);
  const messages: { message: string; kind: string }[] = [];
  const client = loadDashboard(dom, {
    // The write fails; the follow-up read still reports the real server state.
    call: async (path, options) => {
      if (options) throw new Error("request failed");
      return { ok: true, data: { autoEnableNewSites: true, sites: [{ domain: "retry.example.test", type: "php", enabled: false, excludedFromAutomatic: true }] } };
    },
    notify: (message, kind) => messages.push({ message, kind }),
  });

  const input = dom.rows[0]!.parts.toggle;
  input.checked = true;
  await client.setOne(input);

  expect(messages).toEqual([{ message: "Could not update the Cloudflare setting: request failed", kind: "error" }]);
  expect(input.checked).toBe(false);
  expect(input.disabled).toBe(false);
  expect(dom.rows[0]!.parts.toggle.checked).toBe(false);
});

test("a change is not called done while the page could not be refreshed", async () => {
  const dom = fakeDashboard([
    { domain: "one.example.test", enabled: false, excluded: false },
    { domain: "two.example.test", enabled: false, excluded: false },
  ]);
  const messages: { message: string; kind: string }[] = [];
  const order: string[] = [];
  const client = loadDashboard(dom, {
    // The write lands; reading the new state back does not.
    call: async (path, options) => {
      if (options) { order.push("write"); return { ok: true }; }
      order.push("read");
      throw new Error("gateway unavailable");
    },
    busy: (on) => order.push(on ? "held" : "released"),
    notify: (message, kind) => messages.push({ message, kind }),
  });

  await client.runBulk(dom.rows.map((row) => client.rowState(row)), true, "all");

  // The controls stay held across the read, so a second click cannot start a
  // change whose reply arrives first and paints the older state over it.
  expect(order).toEqual(["held", "write", "read", "released"]);
  // The change did happen; what failed is knowing whether the rows still match.
  expect(messages).toEqual([{
    message: "2 sites now allow Cloudflare traffic only. The page may be out of date: gateway unavailable",
    kind: "warn",
  }]);
});

test("an all-sites confirmation names the sites it turns on and the exceptions it clears", async () => {
  const dom = fakeDashboard([
    { domain: "on.example.test", enabled: true, excluded: false },
    { domain: "off.example.test", enabled: false, excluded: true },
    { domain: "also-off.example.test", enabled: false, excluded: false },
  ]);
  let offered: string[] = [];
  const requests: unknown[] = [];
  const client = loadDashboard(dom, {
    call: async (path, options) => {
      if (options) { requests.push(JSON.parse((options as { body: string }).body)); return { ok: true }; }
      return { ok: true, data: { autoEnableNewSites: true, sites: [
        { domain: "on.example.test", type: "php", enabled: true, excludedFromAutomatic: false },
        { domain: "off.example.test", type: "php", enabled: true, excludedFromAutomatic: false },
        { domain: "also-off.example.test", type: "php", enabled: true, excludedFromAutomatic: false },
      ] } };
    },
    confirmAction: async (options) => { offered = options.details ?? []; return true; },
  });

  await client.runBulk(dom.rows.map((row) => client.rowState(row)), true, "all");

  expect(offered[0]).toBe("2 sites currently off are turned on.");
  expect(offered[1]).toBe("1 site stops being excluded from automatic enabling.");
  expect(offered[2]).toBe("These choices replace what is set now and are not restored afterwards.");
  expect(requests).toEqual([{ domains: ["on.example.test", "off.example.test", "also-off.example.test"], enabled: true }]);
  expect(dom.byId["cf-summary"]!.textContent).toBe("3 of 3 sites allow Cloudflare only.");
});

test("cancelling an all-sites action changes nothing", async () => {
  const dom = fakeDashboard([{ domain: "one.example.test", enabled: false, excluded: false }]);
  let called = false;
  const client = loadDashboard(dom, {
    call: async () => { called = true; return { ok: true }; },
    confirmAction: async () => false,
  });

  await client.runBulk(dom.rows.map((row) => client.rowState(row)), true, "all");

  expect(called).toBe(false);
  expect(dom.rows[0]!.dataset.enabled).toBe("false");
});

test("an all-sites action with nothing to change asks for no confirmation and sends no request", async () => {
  const dom = fakeDashboard([{ domain: "one.example.test", enabled: true, excluded: false }]);
  let confirmed = false;
  let called = false;
  const messages: string[] = [];
  const client = loadDashboard(dom, {
    call: async () => { called = true; return { ok: true }; },
    confirmAction: async () => { confirmed = true; return true; },
    notify: (message) => messages.push(message),
  });

  await client.runBulk(dom.rows.map((row) => client.rowState(row)), true, "all");

  expect(confirmed).toBe(false);
  expect(called).toBe(false);
  expect(messages).toEqual(["Every site is already on; nothing to change."]);
});

test("a site turned off after an enable-all stays off when the page repaints", async () => {
  const dom = fakeDashboard([
    { domain: "keep.example.test", enabled: true, excluded: false },
    { domain: "exception.example.test", enabled: true, excluded: false },
  ]);
  const client = loadDashboard(dom, {
    call: async (path, options) => {
      if (options) return { ok: true };
      // What the action records: the flag off and the automatic exception set.
      return { ok: true, data: { autoEnableNewSites: true, sites: [
        { domain: "keep.example.test", type: "php", enabled: true, excludedFromAutomatic: false },
        { domain: "exception.example.test", type: "php", enabled: false, excludedFromAutomatic: true },
      ] } };
    },
  });

  const input = dom.rows[1]!.parts.toggle;
  input.checked = false;
  await client.setOne(input);

  expect(dom.rows[1]!.dataset.enabled).toBe("false");
  expect(dom.rows[1]!.dataset.excluded).toBe("true");
  expect(dom.byId["cf-summary"]!.textContent).toBe("1 of 2 sites allow Cloudflare only.");
});

test("a changed site inventory reloads instead of repainting rows that are not there", async () => {
  const dom = fakeDashboard([{ domain: "gone.example.test", enabled: true, excluded: false }]);
  let reloaded = false;
  const client = loadDashboard(dom, {
    call: async (path, options) => {
      if (options) return { ok: true };
      return { ok: true, data: { autoEnableNewSites: true, sites: [
        { domain: "new.example.test", type: "php", enabled: true, excludedFromAutomatic: false },
      ] } };
    },
    reload: () => { reloaded = true; },
  });

  await client.setOne(dom.rows[0]!.parts.toggle);

  expect(reloaded).toBe(true);
});

test("selection actions stay unavailable until sites are selected", () => {
  const dom = fakeDashboard([
    { domain: "a.example.test", enabled: true, excluded: false },
    { domain: "b.example.test", enabled: false, excluded: false, selected: true },
  ]);
  const client = loadDashboard(dom, { call: async () => ({ ok: true }) });

  client.paintSummary();
  expect(dom.byId["cf-selection"]!.textContent).toBe("1 of 2 selected");
  expect(dom.byId["enable-selected"]!.disabled).toBe(false);
  expect(dom.byId["select-all"]!.indeterminate).toBe(true);

  dom.rows[1]!.parts.checkbox.checked = false;
  client.paintSummary();
  expect(dom.byId["cf-selection"]!.textContent).toBe("No sites selected");
  expect(dom.byId["enable-selected"]!.disabled).toBe(true);
  expect(dom.byId["disable-selected"]!.disabled).toBe(true);
});


test("the mobile select-all button toggles selection and updates label", () => {
  const dom = fakeDashboard([
    { domain: "a.example.test", enabled: true, excluded: false, selected: false },
    { domain: "b.example.test", enabled: false, excluded: false, selected: false },
  ]);
  const client = loadDashboard(dom, { call: async () => ({ ok: true }) });

  client.paintSummary();
  expect(dom.byId["select-all-btn"]!.textContent).toBe("Select all");

  client.toggleAllSites();
  expect(dom.rows.every((r) => r.parts.checkbox.checked)).toBe(true);
  expect(dom.byId["select-all-btn"]!.textContent).toBe("Deselect all");
  expect(dom.byId["cf-selection"]!.textContent).toBe("2 of 2 selected");

  client.toggleAllSites();
  expect(dom.rows.every((r) => !r.parts.checkbox.checked)).toBe(true);
  expect(dom.byId["select-all-btn"]!.textContent).toBe("Select all");
});

test("a site row selects as a whole without the Cloudflare switch changing selection", () => {
  const dom = fakeDashboard([
    { domain: "a.example.test", enabled: true, excluded: false, selected: false },
  ]);
  const client = loadDashboard(dom, { call: async () => ({ ok: true }) });
  const rowTarget = { closest: () => null };

  client.toggleSiteSelection({ type: "click", target: rowTarget }, dom.rows[0]);
  expect(dom.rows[0]!.parts.checkbox.checked).toBe(true);
  expect(dom.rows[0]!.attributes["aria-selected"]).toBe("true");
  expect(dom.byId["cf-selection"]!.textContent).toBe("1 of 1 selected");

  client.toggleSiteSelection({ type: "click", target: { closest: () => ({}) } }, dom.rows[0]);
  expect(dom.rows[0]!.parts.checkbox.checked).toBe(true);

  let prevented = false;
  client.toggleSiteSelection({
    type: "keydown",
    key: " ",
    target: rowTarget,
    preventDefault: () => { prevented = true; },
  }, dom.rows[0]);
  expect(prevented).toBe(true);
  expect(dom.rows[0]!.parts.checkbox.checked).toBe(false);
  expect(dom.rows[0]!.attributes["aria-selected"]).toBe("false");
});

test("vhost transformation mirrors CloudPanel and is reversible", () => {
  const original = vhost("site-user");
  const enabled = transformVhost(original, "site-user", true);
  expect(enabled).toContain("access.log cloudflare;");
  expect(enabled).toContain("include /etc/nginx/cloudflare/ips;");
  expect(transformVhost(enabled, "site-user", false)).toBe(original);
});

test("bulk updates change every selected row and reload Nginx once", async () => {
  const f = fixture();
  const commands: string[] = [];
  try {
    addSite(f.db, f.paths, "one.example.test", "one");
    addSite(f.db, f.paths, "two.example.test", "two");
    f.db.close();
    const code = await runCloudflareAction(["set", "--enabled", "yes"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["one.example.test", "two.example.test"] }),
      emitReply: false,
      run(command, args) {
        commands.push([command, ...args].join(" "));
        return successCommand();
      },
    });
    expect(code).toBe(0);
    const verify = new Database(f.paths.panelDb, { readonly: true });
    expect(verify.query<{ total: number }, []>("SELECT SUM(allow_traffic_from_cloudflare_only) AS total FROM site;").get()!.total).toBe(2);
    verify.close();
    expect(readFileSync(join(f.paths.nginxVhostDir, "one.example.test.conf"), "utf8")).toContain(CLOUDFLARE_MARKER);
    expect(readFileSync(join(f.paths.nginxVhostDir, "two.example.test.conf"), "utf8")).toContain(CLOUDFLARE_MARKER);
    expect(commands).toEqual(["nginx-test -t", "systemctl-test reload nginx"]);
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

const CLOUDFLARE_MARKER = "include /etc/nginx/cloudflare/ips;";

test("failed Nginx validation rolls the database and vhost back", async () => {
  const f = fixture();
  let checks = 0;
  try {
    addSite(f.db, f.paths, "rollback.example.test", "rollback");
    f.db.close();
    const original = readFileSync(join(f.paths.nginxVhostDir, "rollback.example.test.conf"), "utf8");
    const code = await runCloudflareAction(["set", "--enabled", "yes"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["rollback.example.test"] }),
      emitReply: false,
      run(command) {
        if (command === "nginx-test" && checks++ === 0) return { ok: false, stdout: "", stderr: "bad config", exitCode: 1 };
        return successCommand();
      },
    });
    expect(code).toBe(1);
    const verify = new Database(f.paths.panelDb, { readonly: true });
    expect(verify.query<{ enabled: number }, []>("SELECT allow_traffic_from_cloudflare_only AS enabled FROM site;").get()!.enabled).toBe(0);
    verify.close();
    expect(readFileSync(join(f.paths.nginxVhostDir, "rollback.example.test.conf"), "utf8")).toBe(original);
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.serial("database rollback failures are reported with the original update error", async () => {
  const f = fixture();
  try {
    addSite(f.db, f.paths, "database-rollback.example.test", "database-rollback");
    f.db.exec(`CREATE TRIGGER force_transaction_rollback
      BEFORE UPDATE OF allow_traffic_from_cloudflare_only ON site
      BEGIN SELECT RAISE(ROLLBACK, 'forced update rollback'); END;`);
    f.db.close();

    const result = await captureActionFailure(() => runCloudflareAction(["set", "--enabled", "yes"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["database-rollback.example.test"] }),
      emitReply: false,
      run: successCommand,
    }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("forced update rollback");
    expect(result.stderr).toContain("rollback failed: database transaction:");
    const verify = new Database(f.paths.panelDb, { readonly: true });
    expect(verify.query<{ enabled: number }, []>(
      "SELECT allow_traffic_from_cloudflare_only AS enabled FROM site;",
    ).get()!.enabled).toBe(0);
    verify.close();
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.serial("vhost and validation recovery failures are collected while every vhost is attempted", async () => {
  const f = fixture();
  let checks = 0;
  try {
    addSite(f.db, f.paths, "broken.example.test", "broken");
    addSite(f.db, f.paths, "restored.example.test", "restored");
    f.db.close();
    const broken = join(f.paths.nginxVhostDir, "broken.example.test.conf");
    const restored = join(f.paths.nginxVhostDir, "restored.example.test.conf");
    const restoredOriginal = readFileSync(restored, "utf8");

    const result = await captureActionFailure(() => runCloudflareAction(["set", "--enabled", "yes"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["broken.example.test", "restored.example.test"] }),
      emitReply: false,
      run(command) {
        if (command !== "nginx-test") return successCommand();
        if (checks++ === 0) {
          rmSync(broken);
          mkdirSync(broken);
          return { ok: false, stdout: "", stderr: "initial config invalid", exitCode: 1 };
        }
        return { ok: false, stdout: "", stderr: "restored config invalid", exitCode: 1 };
      },
    }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Nginx validation failed: initial config invalid");
    expect(result.stderr).toContain("rollback failed: vhost");
    expect(result.stderr).toContain("broken.example.test.conf");
    expect(result.stderr).toContain("Nginx rollback validation failed: restored config invalid");
    expect(readFileSync(restored, "utf8")).toBe(restoredOriginal);
    const verify = new Database(f.paths.panelDb, { readonly: true });
    expect(verify.query<{ total: number }, []>(
      "SELECT SUM(allow_traffic_from_cloudflare_only) AS total FROM site;",
    ).get()!.total).toBe(0);
    verify.close();
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.serial("a failed rollback reload is reported after the original reload error", async () => {
  const f = fixture();
  let reloads = 0;
  try {
    addSite(f.db, f.paths, "reload-rollback.example.test", "reload-rollback");
    f.db.close();
    const original = readFileSync(join(f.paths.nginxVhostDir, "reload-rollback.example.test.conf"), "utf8");

    const result = await captureActionFailure(() => runCloudflareAction(["set", "--enabled", "yes"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["reload-rollback.example.test"] }),
      emitReply: false,
      run(command) {
        if (command === "nginx-test") return successCommand();
        return reloads++ === 0
          ? { ok: false, stdout: "", stderr: "initial reload failed", exitCode: 1 }
          : { ok: false, stdout: "", stderr: "rollback reload failed", exitCode: 1 };
      },
    }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Nginx reload failed: initial reload failed");
    expect(result.stderr).toContain("rollback failed: Nginx rollback reload failed: rollback reload failed");
    expect(readFileSync(join(f.paths.nginxVhostDir, "reload-rollback.example.test.conf"), "utf8")).toBe(original);
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.serial("policy rollback failures are reported with the site update error", async () => {
  const f = fixture();
  let checks = 0;
  try {
    addSite(f.db, f.paths, "policy-rollback.example.test", "policy-rollback");
    f.db.close();

    const result = await captureActionFailure(() => runCloudflareAction(["set", "--enabled", "yes"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["policy-rollback.example.test"] }),
      emitReply: false,
      run(command) {
        if (command !== "nginx-test" || checks++ > 0) return successCommand();
        rmSync(f.paths.policyFile);
        mkdirSync(f.paths.policyFile);
        return { ok: false, stdout: "", stderr: "site update invalid", exitCode: 1 };
      },
    }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Nginx validation failed: site update invalid");
    expect(result.stderr).toContain("policy rollback failed:");
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("automatic policy enables new site IDs and keeps hostname exceptions off", async () => {
  const f = fixture();
  try {
    addSite(f.db, f.paths, "exception.example.test", "exception");
    f.db.close();
    expect(await runCloudflareAction(["policy", "--enabled", "yes"], {
      paths: f.paths, emitReply: false,
    })).toBe(0);
    expect(await runCloudflareAction(["set", "--enabled", "no"], {
      paths: f.paths,
      input: JSON.stringify({ domains: ["exception.example.test"] }),
      emitReply: false,
      run: successCommand,
    })).toBe(0);

    const changed = new Database(f.paths.panelDb);
    changed.query("DELETE FROM site WHERE domain_name = ?;").run("exception.example.test");
    addSite(changed, f.paths, "exception.example.test", "exception-new");
    addSite(changed, f.paths, "new.example.test", "new-site");
    changed.close();

    const result = await reconcileNewSites(f.paths, successCommand);
    expect(result).toEqual({ discovered: 2, enabled: 1 });
    const verify = new Database(f.paths.panelDb, { readonly: true });
    const rows = verify.query<{ domain: string; enabled: number }, []>(
      "SELECT domain_name AS domain, allow_traffic_from_cloudflare_only AS enabled FROM site ORDER BY domain_name;",
    ).all();
    verify.close();
    expect(rows).toEqual([
      { domain: "exception.example.test", enabled: 0 },
      { domain: "new.example.test", enabled: 1 },
    ]);
    expect(readFileSync(join(f.paths.nginxVhostDir, "exception.example.test.conf"), "utf8")).not.toContain(CLOUDFLARE_MARKER);
    expect(readFileSync(join(f.paths.nginxVhostDir, "new.example.test.conf"), "utf8")).toContain(CLOUDFLARE_MARKER);
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});
