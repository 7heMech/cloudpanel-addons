import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileNewSites, runCloudflareAction, transformVhost, type CloudflareActionPaths,
} from "../addons/cloudflare-ips/action";
import { CLIENT_JS, dashboardView, layout } from "../addons/cloudflare-ips/app/views";
import type { CommandResult } from "../cli/action-common";
import { trustedVhost, withNginxTransaction } from "../cli/nginx-transaction";

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

const site = (domain: string, enabled: boolean) => ({ domain, enabled });

test("dashboard puts the sites first, with the summary in their header and the new-site switch below", () => {
  const html = dashboardView({
    autoEnableNewSites: true,
    sites: [site('"><script>alert(1)</script>.example.test', false), site("a.example.test", true), site("b.example.test", true)],
  });
  expect(html).not.toContain("Enable all sites");
  expect(html).not.toContain("Disable all sites");
  expect(html).not.toContain("type-cell");
  expect(html).toContain('<p class="hint" id="cf-summary">2 of 3 sites allow Cloudflare only</p>');
  expect(html.indexOf("cloudflare-site-table")).toBeLessThan(html.indexOf('id="automatic-policy"'));
  expect(html).toContain('<div class="card split-card cf-policy">');
  expect(html).toContain('id="enable-selected" type="button" disabled data-needs-selection');
  expect(html).toContain('id="disable-selected" type="button" disabled data-needs-selection');
  expect(html).toContain('onclick="toggleSiteSelection(event, this)"');
  expect(html).not.toContain("<script>alert(1)</script>");
  // Under six sites the table fits on a screen and needs no search.
  expect(html).not.toContain('id="fleet-find"');
  expect(dashboardView({ autoEnableNewSites: true, sites: [] })).toContain("No sites found in CloudPanel.");
  expect(() => new Function(CLIENT_JS)).not.toThrow();
});

test("six sites bring a search and an Off filter", () => {
  const sites = ["a", "b", "c", "d", "e", "f"].map((name, index) => site(`${name}.example.test`, index % 2 === 0));
  const html = dashboardView({ autoEnableNewSites: false, sites });
  expect(html).toContain('id="fleet-find"');
  expect(html).toContain('<option value="off">Off</option>');
  expect(html).toContain('data-domain="b.example.test" data-enabled="false" data-show="off"');
  expect(html).toContain('data-domain="a.example.test" data-enabled="true" data-show="on"');
  expect(html).toContain('id="fleet-none" hidden');
});

test("the switch column ends where the table ends, as the Maintenance table does", () => {
  const html = dashboardView({ autoEnableNewSites: true, sites: [site("a.example.test", true)] });
  expect(html).toContain('<th scope="col" class="action-cell">Cloudflare only</th>');
  expect(html).toContain('<td class="action-cell" data-label="Cloudflare only">');
  expect(html).toContain('<button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>');
  const page = layout("Cloudflare IP access", html);
  expect(page).toContain(".cloudflare-site-table td.action-cell::before { display: none; }");
});

interface FakeElement {
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  indeterminate: boolean;
  closest?: (selector: string) => unknown;
}

interface FakeRow {
  dataset: { domain: string; enabled: string };
  hidden: boolean;
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
function fakeDashboard(sites: { domain: string; enabled: boolean; selected?: boolean }[]) {
  const el = (over: Partial<FakeElement> = {}): FakeElement => ({
    textContent: "", hidden: false, disabled: false, checked: false, indeterminate: false, ...over,
  });
  const byId: Record<string, FakeElement> = {
    "clp-content": el(), "site-selection": el(), "select-all": el(),
    "select-all-btn": el({ textContent: "Select all" }),
    "enable-selected": el({ disabled: true }), "disable-selected": el({ disabled: true }),
  };
  const rows: FakeRow[] = sites.map((entry) => {
    const attributes: Record<string, string> = { "aria-selected": "false" };
    const parts = { checkbox: el({ checked: Boolean(entry.selected) }), toggle: el({ checked: entry.enabled }) };
    const row: FakeRow = {
      dataset: { domain: entry.domain, enabled: String(entry.enabled) },
      hidden: false,
      attributes,
      setAttribute: (name, value) => { attributes[name] = value; },
      querySelector: (selector) => ({ ".site-checkbox": parts.checkbox, ".site-switch": parts.toggle }[selector] ?? null),
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
      if (selector === "[data-needs-selection]") return [byId["enable-selected"], byId["disable-selected"]];
      return [];
    },
  };
  return { document, rows, byId };
}

interface DashboardClient {
  setOne(input: unknown): Promise<void>;
  setSelectedSites(enabled: boolean): Promise<void>;
  paintFleetSelection(): void;
  toggleAllSites(): void;
  toggleSiteSelection(event: unknown, row: unknown): void;
}

function loadDashboard(
  dom: ReturnType<typeof fakeDashboard>,
  handlers: {
    call: (path: string, options?: unknown) => Promise<unknown>;
    confirmAction?: (options: { title?: string; text?: string; danger?: boolean }) => Promise<boolean>;
    notify?: (message: string, kind: string) => void;
    busy?: (on: boolean) => void;
    repaintView?: (holder: unknown, html: string) => void;
  },
): DashboardClient {
  const factory = new Function(
    "CLP_ROOT", "document", "plural", "call", "busy", "notify", "clearNotice", "confirmAction", "repaintView",
    `${CLIENT_JS}\nreturn { setOne, setSelectedSites, paintFleetSelection, toggleAllSites, toggleSiteSelection };`,
  ) as (...args: unknown[]) => DashboardClient;
  return factory(
    // BASE_CLIENT_JS supplies these; on this page, which never mounts in a
    // shadow root, its CLP_ROOT is the document.
    dom.document,
    dom.document,
    (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s"),
    handlers.call,
    handlers.busy ?? (() => {}),
    handlers.notify ?? (() => {}),
    () => {},
    handlers.confirmAction ?? (async () => true),
    handlers.repaintView ?? (() => {}),
  );
}

test("a failed per-site update reports inline and repaints from the server", async () => {
  const dom = fakeDashboard([{ domain: "retry.example.test", enabled: false }]);
  const messages: { message: string; kind: string }[] = [];
  const painted: string[] = [];
  const client = loadDashboard(dom, {
    // The write fails; the follow-up read still returns the server's page.
    call: async (path, options) => {
      if (options) throw new Error("request failed");
      return { ok: true, html: "server state" };
    },
    notify: (message, kind) => messages.push({ message, kind }),
    repaintView: (holder, html) => {
      expect(holder).toBe(dom.byId["clp-content"]);
      painted.push(html);
    },
  });

  const input = dom.rows[0]!.parts.toggle;
  input.checked = true;
  await client.setOne(input);

  expect(messages).toEqual([{ message: "Could not update the Cloudflare setting: request failed", kind: "error" }]);
  expect(painted).toEqual(["server state"]);
});

test("a change is not called done while the page could not be refreshed", async () => {
  const dom = fakeDashboard([
    { domain: "one.example.test", enabled: false, selected: true },
    { domain: "two.example.test", enabled: false, selected: true },
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

  await client.setSelectedSites(true);

  // The controls stay held across the read, so a second click cannot start a
  // change whose reply arrives first and paints the older state over it.
  expect(order).toEqual(["held", "write", "read", "released"]);
  expect(messages).toEqual([{
    message: "2 sites now allow Cloudflare traffic only. The page may be out of date: gateway unavailable",
    kind: "warn",
  }]);
});

test("enabling the selection warns that sites not behind Cloudflare stop answering", async () => {
  const dom = fakeDashboard([
    { domain: "on.example.test", enabled: true, selected: true },
    { domain: "off.example.test", enabled: false, selected: true },
    { domain: "untouched.example.test", enabled: false },
  ]);
  let offered: { title?: string; text?: string; danger?: boolean; details?: unknown } = {};
  const requests: unknown[] = [];
  const client = loadDashboard(dom, {
    call: async (path, options) => {
      if (options) requests.push(JSON.parse((options as { body: string }).body));
      return { ok: true, html: "" };
    },
    confirmAction: async (options) => { offered = options; return true; },
  });

  await client.setSelectedSites(true);

  expect(offered.title).toBe("Allow only Cloudflare to reach 1 site?");
  expect(offered.text).toBe("A site not proxied through Cloudflare stops answering its visitors.");
  expect(offered.danger).toBe(true);
  expect(offered.details).toBeUndefined();
  expect(requests).toEqual([{ domains: ["on.example.test", "off.example.test"], enabled: true }]);
});

test("cancelling a selection change sends nothing", async () => {
  const dom = fakeDashboard([{ domain: "one.example.test", enabled: false, selected: true }]);
  let called = false;
  const client = loadDashboard(dom, {
    call: async () => { called = true; return { ok: true }; },
    confirmAction: async () => false,
  });

  await client.setSelectedSites(true);

  expect(called).toBe(false);
});

test("a selection with nothing to change asks for no confirmation and sends no request", async () => {
  const dom = fakeDashboard([{ domain: "one.example.test", enabled: true, selected: true }]);
  let confirmed = false;
  let called = false;
  const messages: string[] = [];
  const client = loadDashboard(dom, {
    call: async () => { called = true; return { ok: true }; },
    confirmAction: async () => { confirmed = true; return true; },
    notify: (message) => messages.push(message),
  });

  await client.setSelectedSites(true);

  expect(confirmed).toBe(false);
  expect(called).toBe(false);
  expect(messages).toEqual(["The selected sites are already on; nothing to change."]);
});

test("selection actions stay unavailable until sites are selected", () => {
  const dom = fakeDashboard([
    { domain: "a.example.test", enabled: true },
    { domain: "b.example.test", enabled: false, selected: true },
  ]);
  const client = loadDashboard(dom, { call: async () => ({ ok: true }) });

  client.paintFleetSelection();
  expect(dom.byId["site-selection"]!.textContent).toBe("1 of 2 selected");
  expect(dom.byId["enable-selected"]!.disabled).toBe(false);
  expect(dom.byId["select-all"]!.indeterminate).toBe(true);

  dom.rows[1]!.parts.checkbox.checked = false;
  client.paintFleetSelection();
  expect(dom.byId["site-selection"]!.textContent).toBe("No sites selected");
  expect(dom.byId["enable-selected"]!.disabled).toBe(true);
  expect(dom.byId["disable-selected"]!.disabled).toBe(true);
});

test("Cloudflare site rows support mouse and keyboard selection", () => {
  const dom = fakeDashboard([
    { domain: "one.example.test", enabled: true },
    { domain: "two.example.test", enabled: false },
  ]);
  const client = loadDashboard(dom, { call: async () => ({ ok: true }) });

  client.toggleSiteSelection({ type: "click", target: { closest: () => null } }, dom.rows[0]);
  expect(dom.rows[0]!.parts.checkbox.checked).toBe(true);
  expect(dom.rows[0]!.attributes["aria-selected"]).toBe("true");
  expect(dom.byId["site-selection"]!.textContent).toBe("1 of 2 selected");

  client.toggleSiteSelection({ type: "click", target: { closest: () => ({}) } }, dom.rows[0]);
  expect(dom.rows[0]!.parts.checkbox.checked).toBe(true);

  client.toggleAllSites();
  expect(dom.rows.every((row) => row.parts.checkbox.checked)).toBe(true);
  expect(dom.byId["select-all-btn"]!.textContent).toBe("Deselect all");

  let prevented = false;
  client.toggleSiteSelection({
    type: "keydown", key: " ", target: { closest: () => null }, preventDefault: () => { prevented = true; },
  }, dom.rows[1]);
  expect(prevented).toBe(true);
  expect(dom.rows[1]!.parts.checkbox.checked).toBe(false);
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

test("vhost recovery completes before releasing the database lock to another addon", () => {
  const f = fixture();
  let second: Database | undefined;
  try {
    addSite(f.db, f.paths, "concurrent.example.test", "concurrent");
    const path = join(f.paths.nginxVhostDir, "concurrent.example.test.conf");
    second = new Database(f.paths.panelDb);
    const execute = f.db.exec.bind(f.db);
    f.db.exec = (sql, ...bindings) => {
      const result = execute(sql, ...bindings);
      if (sql === "ROLLBACK;") {
        withNginxTransaction(second!, f.paths, successCommand, (changes) => {
          const backup = trustedVhost(path, realUid);
          changes.push({ backup, content: transformVhost(backup.content, "concurrent", true) });
          second!.exec("UPDATE site SET allow_traffic_from_cloudflare_only = 1;");
        });
      }
      return result;
    };
    let checks = 0;
    expect(() => withNginxTransaction(f.db, f.paths, () => checks++ === 0
      ? { ok: false, stdout: "", stderr: "initial validation failed" } : successCommand(), (changes) => {
      const backup = trustedVhost(path, realUid);
      changes.push({ backup, content: `${backup.content}\n# failed WordPress change\n` });
    })).toThrow("initial validation failed");
    expect(second.query<{ enabled: number }, []>(
      "SELECT allow_traffic_from_cloudflare_only AS enabled FROM site;",
    ).get()!.enabled).toBe(1);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("include /etc/nginx/cloudflare/ips;");
    expect(content).not.toContain("failed WordPress change");
  } finally {
    second?.close();
    f.db.close();
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
    expect(result).toEqual({ discovered: 2, enabled: 1, failed: [] });
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

test("a hand-edited vhost is skipped by name while the other new sites are protected and recorded", async () => {
  const f = fixture();
  try {
    f.db.close();
    expect(await runCloudflareAction(["policy", "--enabled", "yes"], { paths: f.paths, emitReply: false })).toBe(0);

    const changed = new Database(f.paths.panelDb);
    const editedId = addSite(changed, f.paths, "edited.example.test", "edited");
    const freshId = addSite(changed, f.paths, "fresh.example.test", "fresh");
    changed.close();
    const edited = join(f.paths.nginxVhostDir, "edited.example.test.conf");
    writeFileSync(edited, readFileSync(edited, "utf8").replace(/^\s*access_log.*$/m, "  access_log off;"));

    const first = await reconcileNewSites(f.paths, successCommand);
    expect(first.enabled).toBe(1);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]!.domain).toBe("edited.example.test");
    expect(first.failed[0]!.error).toStartWith("edited.example.test: ");
    expect(readFileSync(join(f.paths.nginxVhostDir, "fresh.example.test.conf"), "utf8")).toContain(CLOUDFLARE_MARKER);
    const known = (JSON.parse(readFileSync(f.paths.policyFile, "utf8")) as { knownSiteIds: number[] }).knownSiteIds;
    expect(known).toContain(freshId);
    expect(known).not.toContain(editedId);

    // Once the vhost is fixed, the next pass protects the site it skipped.
    writeFileSync(edited, transformVhost(vhost("edited"), "edited", false));
    const second = await reconcileNewSites(f.paths, successCommand);
    expect(second).toEqual({ discovered: 1, enabled: 1, failed: [] });
    expect(readFileSync(edited, "utf8")).toContain(CLOUDFLARE_MARKER);
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a pass with no new site leaves the policy file alone", async () => {
  const f = fixture();
  try {
    addSite(f.db, f.paths, "one.example.test", "one");
    f.db.close();
    expect(await runCloudflareAction(["policy", "--enabled", "yes"], { paths: f.paths, emitReply: false })).toBe(0);
    const before = statSync(f.paths.policyFile).mtimeMs;
    await Bun.sleep(20);
    expect(await reconcileNewSites(f.paths, successCommand)).toEqual({ discovered: 0, enabled: 0, failed: [] });
    expect(statSync(f.paths.policyFile).mtimeMs).toBe(before);
  } finally {
    try { f.db.close(); } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});
