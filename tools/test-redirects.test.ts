import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeRedirectsAction, readRedirectBlock, reconcileRedirects, redirectBlock, runRedirectsAction,
  withRedirectBlock, withoutRedirectBlock,
  type RedirectsActionPaths, type RedirectsState, type ReconcileResult,
} from "../addons/redirects/action";
import { CLIENT_JS, fleetView, siteCardHtml } from "../addons/redirects/app/views";
import type { CommandResult } from "../cli/action-common";

/**
 * The panel-identity guard reads a root-owned file, which a test running as an
 * ordinary user cannot create, so the domain normaliser is injected the way
 * the Maintenance action's tests inject it.
 */
const normalizeForTest = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");

const realUid = process.getuid?.() ?? 0;
const originalGetuid = process.getuid;

beforeEach(() => {
  Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "getuid", { value: originalGetuid, configurable: true });
});

/** CloudPanel 6.0.8's stored Static template, as the panel writes it. */
function staticTemplate(domain: string, user: string, rendered: boolean): string {
  return `server {
  listen 80;
  listen 443 ssl;
  ${rendered ? `ssl_certificate /etc/nginx/ssl-certificates/${domain}.crt;` : "{{ssl_certificate}}"}
  server_name ${domain};
  ${rendered ? `root /home/${user}/htdocs/${domain};` : "{{root}}"}

  ${rendered ? `access_log /home/${user}/logs/nginx/access.log main;` : "{{nginx_access_log}}"}

  if ($scheme != "https") {
    rewrite ^ https://$host$request_uri permanent;
  }

  location ~ /.well-known {
    auth_basic off;
    allow all;
  }

  ${rendered ? "" : "{{settings}}"}

  include /etc/nginx/global_settings;

  index index.html;

  location ~* ^.+\\.(css|js|png)$ {
    expires max;
    access_log off;
  }

  if (-f $request_filename) {
    break;
  }
}
`;
}

interface Fixture {
  root: string;
  db: Database;
  paths: RedirectsActionPaths;
  commands: string[][];
}

function fixture(run: (command: string, args: string[]) => CommandResult = () => ok()): Fixture & {
  run: (command: string, args: string[]) => CommandResult;
} {
  const root = mkdtempSync(join(tmpdir(), "redirects-test-"));
  const nginxVhostDir = join(root, "vhosts");
  mkdirSync(nginxVhostDir);
  const panelDb = join(root, "panel.sqlite");
  const db = new Database(panelDb);
  db.exec(`CREATE TABLE site (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_name TEXT UNIQUE NOT NULL,
    user TEXT NOT NULL,
    type TEXT NOT NULL,
    vhost_template TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  const identity = join(root, "panel-identity.conf");
  writeFileSync(identity, "PRIMARY=panel.example.test\nALIASES=\n", { mode: 0o600 });
  const commands: string[][] = [];
  const recorded = (command: string, args: string[]): CommandResult => {
    commands.push([command, ...args]);
    return run(command, args);
  };
  return {
    root,
    db,
    commands,
    run: recorded,
    paths: {
      panelDb,
      nginxVhostDir,
      stateFile: join(root, "state", "redirects.json"),
      lockFile: join(root, "locks", "redirects.lock"),
      panelIdentityFile: identity,
      clpctl: "clpctl-test",
      nginx: "nginx-test",
      systemctl: "systemctl-test",
      vhostUid: realUid,
      stateUid: realUid,
    },
  };
}

function ok(stdout = ""): CommandResult {
  return { ok: true, stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string): CommandResult {
  return { ok: false, stdout: "", stderr, exitCode: 1 };
}

function addSite(fix: Fixture, domain: string, type = "static", user = "siteuser"): void {
  fix.db.query("INSERT INTO site (domain_name, user, type, vhost_template) VALUES (?, ?, ?, ?);")
    .run(domain, user, type, staticTemplate(domain, user, false));
  const file = join(fix.paths.nginxVhostDir, `${domain}.conf`);
  writeFileSync(file, staticTemplate(domain, user, true), { mode: 0o644 });
  chmodSync(file, 0o644);
}

function vhostOf(fix: Fixture, domain: string): string {
  return readFileSync(join(fix.paths.nginxVhostDir, `${domain}.conf`), "utf8");
}

function templateOf(fix: Fixture, domain: string): string {
  return String(fix.db.query<{ vhost_template: string }, [string]>(
    "SELECT vhost_template FROM site WHERE domain_name = ?;",
  ).get(domain)!.vhost_template);
}

function cleanup(fix: Fixture): void {
  fix.db.close();
  rmSync(fix.root, { recursive: true, force: true });
}

async function failureOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the action to fail");
}

test("setting a redirect writes the stored template and the rendered vhost together", async () => {
  const fix = fixture();
  try {
    addSite(fix, "old.example.test");
    const state = await executeRedirectsAction(
      ["set", "--domain=old.example.test"],
      { paths: fix.paths, domainValidator: normalizeForTest, input: JSON.stringify({ target: "https://www.example.test", code: 301 }), run: fix.run },
    ) as RedirectsState;

    const expected = "return 301 https://www.example.test$request_uri;";
    expect(vhostOf(fix, "old.example.test")).toContain(expected);
    // Both, because the panel regenerates the file from the column: writing
    // only the file loses the redirect at the next certificate install.
    expect(templateOf(fix, "old.example.test")).toContain(expected);
    // The block is a regex location placed before the asset regex the stock
    // static vhost ends with, so /style.css redirects rather than 404s.
    expect(vhostOf(fix, "old.example.test")).toContain("location ~ ^/ {");
    expect(vhostOf(fix, "old.example.test").indexOf("location ~ ^/ {"))
      .toBeLessThan(vhostOf(fix, "old.example.test").indexOf("location ~* ^.+"));
    // What Let's Encrypt needs to renew this site's own certificate, and the
    // panel's http->https rewrite, are both left alone.
    expect(vhostOf(fix, "old.example.test")).toContain("location ~ /.well-known {");
    expect(vhostOf(fix, "old.example.test")).toContain('rewrite ^ https://$host$request_uri permanent;');
    expect(templateOf(fix, "old.example.test")).toContain("{{ssl_certificate}}");

    expect(state.redirects).toEqual([{
      domain: "old.example.test", target: "https://www.example.test", code: 301,
      preservePath: true, type: "static", applied: true,
    }]);
    expect(JSON.parse(readFileSync(fix.paths.stateFile, "utf8")).redirects).toHaveLength(1);
    expect(fix.commands).toEqual([["nginx-test", "-t"], ["systemctl-test", "reload", "nginx"]]);
  } finally {
    cleanup(fix);
  }
});

test("a redirect that drops the path sends every request to the target itself", async () => {
  const fix = fixture();
  try {
    addSite(fix, "old.example.test");
    await executeRedirectsAction(
      ["set", "--domain=old.example.test"],
      {
        paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
        input: JSON.stringify({ target: "https://www.example.test/landing", code: 302, preservePath: false }),
      },
    );
    expect(vhostOf(fix, "old.example.test")).toContain("return 302 https://www.example.test/landing;");
    expect(vhostOf(fix, "old.example.test")).not.toContain("$request_uri;\n  }");
  } finally {
    cleanup(fix);
  }
});

test("only an absolute http(s) URL that cannot reach Nginx's own syntax is accepted", async () => {
  const fix = fixture();
  try {
    addSite(fix, "old.example.test");
    const set = (body: Record<string, unknown>) => failureOf(() => executeRedirectsAction(
      ["set", "--domain=old.example.test"],
      { paths: fix.paths, domainValidator: normalizeForTest, input: JSON.stringify({ code: 301, ...body }), run: fix.run },
    ));

    expect(await set({ target: "/elsewhere" })).toContain("absolute http:// or https:// URL");
    expect(await set({ target: "javascript:alert(1)" })).toContain("must use http:// or https://");
    expect(await set({ target: "ftp://files.example.test" })).toContain("must use http:// or https://");
    expect(await set({ target: "https://user:pass@www.example.test" })).toContain("must not carry credentials");
    expect(await set({ target: "https://www.example.test/#top" })).toContain("must not carry a fragment");
    // `$` is a variable to Nginx and `;` ends the directive, so neither is
    // escaped into the vhost -- the target is refused instead.
    expect(await set({ target: "https://www.example.test/$host" })).toContain("characters Nginx cannot be given");
    expect(await set({ target: "https://www.example.test/a;return" })).toContain("characters Nginx cannot be given");
    expect(await set({ target: "https://old.example.test/here" })).toContain("would redirect forever");
    expect(await set({ target: "https://www.example.test/?a=b" })).toContain("cannot also preserve the request path");
    expect(await set({ target: "https://www.example.test", code: 307 })).toContain("code must be 301 or 302");
    expect(await set({ target: `https://www.example.test/${"x".repeat(520)}` })).toContain("too long");

    // Nothing was written by any of them.
    expect(vhostOf(fix, "old.example.test")).not.toContain("return 30");
    expect(existsSync(fix.paths.stateFile)).toBe(false);
  } finally {
    cleanup(fix);
  }
});

test("a query string is allowed once the request path is not preserved", async () => {
  const fix = fixture();
  try {
    addSite(fix, "old.example.test");
    await executeRedirectsAction(["set", "--domain=old.example.test"], {
      paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
      input: JSON.stringify({ target: "https://www.example.test/?utm_source=old", code: 301, preservePath: false }),
    });
    expect(vhostOf(fix, "old.example.test")).toContain("return 301 https://www.example.test/?utm_source=old;");
  } finally {
    cleanup(fix);
  }
});

test("a redirect only goes on a static site, and only on a vhost this addon recognises", async () => {
  const fix = fixture();
  try {
    addSite(fix, "shop.example.test", "php");
    addSite(fix, "custom.example.test");
    writeFileSync(
      join(fix.paths.nginxVhostDir, "custom.example.test.conf"),
      "server {\n  server_name custom.example.test;\n}\n",
      { mode: 0o644 },
    );
    const body = JSON.stringify({ target: "https://www.example.test", code: 301 });

    expect(await failureOf(() => executeRedirectsAction(
      ["set", "--domain=shop.example.test"], { paths: fix.paths, domainValidator: normalizeForTest, input: body, run: fix.run },
    ))).toContain("is a php site");
    expect(await failureOf(() => executeRedirectsAction(
      ["set", "--domain=missing.example.test"], { paths: fix.paths, domainValidator: normalizeForTest, input: body, run: fix.run },
    ))).toContain("no CloudPanel site found");
    expect(await failureOf(() => executeRedirectsAction(
      ["set", "--domain=custom.example.test"], { paths: fix.paths, domainValidator: normalizeForTest, input: body, run: fix.run },
    ))).toContain("no CloudPanel .well-known block");
  } finally {
    cleanup(fix);
  }
});

test("a failed Nginx check leaves the site exactly as it was", async () => {
  const fix = fixture((command, args) => (args[0] === "-t" ? fail("invalid directive") : ok()));
  try {
    addSite(fix, "old.example.test");
    const before = { vhost: vhostOf(fix, "old.example.test"), template: templateOf(fix, "old.example.test") };

    const message = await failureOf(() => executeRedirectsAction(["set", "--domain=old.example.test"], {
      paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
      input: JSON.stringify({ target: "https://www.example.test", code: 301 }),
    }));

    expect(message).toContain("Nginx validation failed: invalid directive");
    expect(vhostOf(fix, "old.example.test")).toBe(before.vhost);
    expect(templateOf(fix, "old.example.test")).toBe(before.template);
    expect(existsSync(fix.paths.stateFile)).toBe(false);
    // The restored file is validated, and not reloaded, because the reload was
    // never reached.
    expect(fix.commands.filter((entry) => entry[1] === "reload")).toHaveLength(0);
  } finally {
    cleanup(fix);
  }
});

test("clearing a redirect leaves the stock static site behind", async () => {
  const fix = fixture();
  try {
    addSite(fix, "old.example.test");
    const stock = { vhost: vhostOf(fix, "old.example.test"), template: templateOf(fix, "old.example.test") };
    await executeRedirectsAction(["set", "--domain=old.example.test"], {
      paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
      input: JSON.stringify({ target: "https://www.example.test", code: 301 }),
    });

    const state = await executeRedirectsAction(
      ["clear", "--domain=old.example.test"], { paths: fix.paths, domainValidator: normalizeForTest, run: fix.run },
    ) as RedirectsState;

    expect(state.redirects).toEqual([]);
    expect(vhostOf(fix, "old.example.test")).toBe(stock.vhost);
    expect(templateOf(fix, "old.example.test")).toBe(stock.template);
    expect(await failureOf(() => executeRedirectsAction(
      ["clear", "--domain=old.example.test"], { paths: fix.paths, domainValidator: normalizeForTest, run: fix.run },
    ))).toContain("has no redirect");
  } finally {
    cleanup(fix);
  }
});

test("repair puts back a redirect whose vhost CloudPanel regenerated, and is quiet otherwise", async () => {
  const fix = fixture();
  try {
    addSite(fix, "old.example.test");
    await executeRedirectsAction(["set", "--domain=old.example.test"], {
      paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
      input: JSON.stringify({ target: "https://www.example.test", code: 301 }),
    });

    expect(await reconcileRedirects(fix.paths, fix.run)).toEqual({ repaired: [] });

    // What a certificate install leaves behind: the panel's own template again.
    writeFileSync(
      join(fix.paths.nginxVhostDir, "old.example.test.conf"),
      staticTemplate("old.example.test", "siteuser", true),
      { mode: 0o644 },
    );
    fix.db.query("UPDATE site SET vhost_template = ? WHERE domain_name = ?;")
      .run(staticTemplate("old.example.test", "siteuser", false), "old.example.test");

    const listed = await executeRedirectsAction(["list"], { paths: fix.paths, domainValidator: normalizeForTest, run: fix.run }) as RedirectsState;
    expect(listed.redirects[0]!.applied).toBe(false);

    expect(await reconcileRedirects(fix.paths, fix.run)).toEqual({ repaired: ["old.example.test"] });
    expect(vhostOf(fix, "old.example.test")).toContain("return 301 https://www.example.test$request_uri;");
    expect(templateOf(fix, "old.example.test")).toContain("return 301 https://www.example.test$request_uri;");
    expect(await reconcileRedirects(fix.paths, fix.run)).toEqual({ repaired: [] });
  } finally {
    cleanup(fix);
  }
});

test("repair leaves a redirect whose site the operator deleted in CloudPanel", async () => {
  const fix = fixture();
  try {
    addSite(fix, "old.example.test");
    await executeRedirectsAction(["set", "--domain=old.example.test"], {
      paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
      input: JSON.stringify({ target: "https://www.example.test", code: 301 }),
    });
    fix.db.query("DELETE FROM site WHERE domain_name = ?;").run("old.example.test");

    expect(await reconcileRedirects(fix.paths, fix.run)).toEqual({ repaired: [] });
    const listed = await executeRedirectsAction(["list"], { paths: fix.paths, domainValidator: normalizeForTest, run: fix.run }) as RedirectsState;
    expect(listed.redirects[0]).toMatchObject({ type: "", applied: false });
  } finally {
    cleanup(fix);
  }
});

test("creating a redirect site asks clpctl for a static site with a derived site user", async () => {
  const fix = fixture((command, args) => {
    if (args[0] === "site:add:static") {
      const domain = args.find((arg) => arg.startsWith("--domainName="))!.slice("--domainName=".length);
      addSite(fix, domain, "static", "addon-newexamp-ec0b9a");
    }
    return ok();
  });
  try {
    const state = await executeRedirectsAction(["create", "--domain=new.example.test"], {
      paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
      input: JSON.stringify({ target: "https://www.example.test", code: 301 }),
    }) as RedirectsState;

    const create = fix.commands.find((entry) => entry[1] === "site:add:static")!;
    expect(create[0]).toBe("clpctl-test");
    expect(create).toContain("--domainName=new.example.test");
    expect(create.some((arg) => /^--siteUser=addon-newexamp-[0-9a-f]{6}$/.test(arg))).toBe(true);
    // The password is generated and never reported: nothing signs in to a site
    // whose only job is to redirect.
    expect(create.some((arg) => arg.startsWith("--siteUserPassword="))).toBe(true);
    expect(JSON.stringify(state)).not.toContain("siteUserPassword");
    expect(state.redirects).toHaveLength(1);
    expect(vhostOf(fix, "new.example.test")).toContain("return 301 https://www.example.test$request_uri;");

    expect(await failureOf(() => executeRedirectsAction(["create", "--domain=new.example.test"], {
      paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
      input: JSON.stringify({ target: "https://www.example.test", code: 301 }),
    }))).toContain("already exists in CloudPanel");
  } finally {
    cleanup(fix);
  }
});

test("a create whose redirect cannot be applied takes its own new site away again", async () => {
  const fix = fixture((command, args) => {
    if (args[0] === "site:add:static") {
      addSite(fix, "new.example.test", "static", "addon-newexamp-ec0b9a");
      return ok();
    }
    return args[0] === "-t" ? fail("invalid directive") : ok();
  });
  try {
    const message = await failureOf(() => executeRedirectsAction(["create", "--domain=new.example.test"], {
      paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
      input: JSON.stringify({ target: "https://www.example.test", code: 301 }),
    }));
    expect(message).toContain("Nginx validation failed");
    expect(fix.commands.some((entry) => entry[1] === "site:delete" && entry.includes("--domainName=new.example.test")))
      .toBe(true);
  } finally {
    cleanup(fix);
  }
});

test("an action reply names the addon and never leaks a stack trace", async () => {
  const fix = fixture();
  try {
    let stderr = "";
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await runRedirectsAction(["nonsense"], { paths: fix.paths, domainValidator: normalizeForTest, run: fix.run });
    } finally {
      process.stderr.write = write;
    }
    expect(code).toBe(1);
    expect(stderr).toBe("[redirects] ERROR: unknown redirects action 'nonsense'\n");
  } finally {
    cleanup(fix);
  }
});

test("the block is written, read back and removed as one marked region", () => {
  const content = staticTemplate("old.example.test", "siteuser", true);
  const redirect = { domain: "old.example.test", target: "https://www.example.test", code: 302 as const, preservePath: false };
  const applied = withRedirectBlock(content, redirect);
  expect(readRedirectBlock(applied)).toEqual({ target: "https://www.example.test", code: 302, preservePath: false });
  expect(readRedirectBlock(content)).toBeNull();
  expect(withoutRedirectBlock(applied)).toBe(content);
  // Applying twice replaces the block rather than stacking a second one.
  expect(withRedirectBlock(applied, { ...redirect, code: 301 })).toBe(withRedirectBlock(content, { ...redirect, code: 301 }));
  expect(redirectBlock({ ...redirect, preservePath: true })).toContain("$request_uri;");
});

/* -------------------------------------------------------------------- page */

const sample = {
  redirects: [
    { domain: "old.example.test", target: "https://www.example.test", code: 301 as const, preservePath: true, type: "static", applied: true },
    { domain: "drifted.example.test", target: "https://www.example.test/landing", code: 302 as const, preservePath: false, type: "static", applied: false },
  ],
};

test("the fleet page lists every redirect with a create form and inline edit controls", () => {
  const html = fleetView(sample);
  expect(html).toContain("2 redirects");
  expect(html).toContain('id="new-domain"');
  expect(html).toContain('id="new-target"');
  expect(html).toContain('onclick="createRedirect()"');
  expect(html).toContain('data-domain="old.example.test"');
  expect(html).toContain("https://www.example.test/landing");
  expect(html).toContain("301 permanent");
  expect(html).toContain("302 temporary");
  expect(html).toContain('class="row-edit redirect-input"');
  expect(html).toContain(`onclick="saveRedirect('old.example.test')"`);
  // The site whose vhost was regenerated says so; the applied one does not.
  expect(html).toContain('<div class="hint redirect-repair">CloudPanel rewrote this vhost');
  expect(html).toContain('<div class="hint redirect-repair" hidden>');
  expect(fleetView({ redirects: [] })).toContain("No redirect sites yet.");
  expect(() => new Function(CLIENT_JS)).not.toThrow();
});

test("the fleet table is the shared mobile layout, so every cell names its column", () => {
  const html = fleetView(sample);
  expect(html).toContain('<table class="fleet-table">');
  expect(html).toContain('data-label="Redirects to"');
  expect(html).toContain('data-label="Response"');
  expect(html).toContain('data-label="Request path"');
});

test("a page whose data came from a hostile site name renders it as text", () => {
  const html = fleetView({
    redirects: [{
      domain: '"><script>alert(1)</script>.example.test',
      target: '"><img src=x onerror=alert(1)>', code: 301, preservePath: true, type: "static", applied: true,
    }],
  });
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toContain("<img src=x");
});

test("the panel's own site card shows the target and says when it is not applied", () => {
  const applied = siteCardHtml(sample.redirects[0]!);
  expect(applied).toContain("Redirects To");
  expect(applied).toContain("https://www.example.test");
  expect(applied).toContain("301 permanent");
  expect(applied).not.toContain("form-text");
  expect(siteCardHtml(sample.redirects[1]!)).toContain("CloudPanel has rewritten this site's vhost");
});

interface FakeElement {
  value: string;
  checked: boolean;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  focus: () => void;
}

interface FakeRow {
  dataset: Record<string, string>;
  classList: { add: (name: string) => void; remove: (name: string) => void };
  querySelector: (selector: string) => FakeElement | null;
  querySelectorAll: (selector: string) => FakeElement[];
  parts: Record<string, FakeElement>;
}

interface PageClient {
  editRedirect(domain: string): void;
  cancelRedirect(domain: string): void;
  saveRedirect(domain: string): Promise<void>;
  clearRedirect(domain: string): Promise<void>;
  createRedirect(): Promise<void>;
}

/** Just enough DOM for the row the page edits in place. */
function fakePage(redirect: { domain: string; target: string; code: string; preserve: string }) {
  const el = (over: Partial<FakeElement> = {}): FakeElement => ({
    value: "", checked: false, textContent: "", hidden: false, disabled: false, focus() {}, ...over,
  });
  const parts: Record<string, FakeElement> = {
    ".redirect-input": el({ value: redirect.target }),
    ".redirect-code": el({ value: redirect.code }),
    ".redirect-preserve": el({ checked: redirect.preserve === "true" }),
    ".redirect-target-text": el({ textContent: redirect.target }),
    ".redirect-code-text": el(),
    ".redirect-path-text": el(),
    ".redirect-repair": el({ hidden: true }),
  };
  const classes: string[] = [];
  const row: FakeRow = {
    dataset: { domain: redirect.domain, target: redirect.target, code: redirect.code, preserve: redirect.preserve },
    classList: {
      add: (name) => classes.push(name),
      remove: (name) => classes.splice(classes.indexOf(name) >>> 0, classes.includes(name) ? 1 : 0),
    },
    querySelector: (selector) => parts[selector] ?? null,
    querySelectorAll: () => [],
    parts,
  };
  const byId: Record<string, FakeElement> = {
    "new-domain": el(), "new-target": el(), "new-code": el({ value: "301" }), "new-preserve": el({ checked: true }),
  };
  return {
    parts,
    row,
    byId,
    classes,
    root: {
      querySelector: (selector: string) => (selector.startsWith("tr[data-domain") ? row : null),
      getElementById: (id: string) => byId[id] ?? null,
    },
  };
}

function loadPage(
  dom: ReturnType<typeof fakePage>,
  handlers: {
    call: (path: string, options?: { body?: string }) => Promise<unknown>;
    confirmAction?: () => Promise<boolean>;
    notify?: (message: string, kind: string) => void;
    reload?: () => void;
  },
): PageClient {
  const factory = new Function(
    "CLP_ROOT", "call", "busy", "notify", "clearNotice", "confirmAction", "location",
    `${CLIENT_JS}\nreturn { editRedirect, cancelRedirect, saveRedirect, clearRedirect, createRedirect };`,
  ) as (...args: unknown[]) => PageClient;
  return factory(
    dom.root,
    handlers.call,
    () => {},
    handlers.notify ?? (() => {}),
    () => {},
    handlers.confirmAction ?? (async () => true),
    { reload: handlers.reload ?? (() => {}) },
  );
}

test("saving an edit that changed nothing sends no request and closes the row", async () => {
  const dom = fakePage({ domain: "old.example.test", target: "https://www.example.test", code: "301", preserve: "true" });
  const calls: string[] = [];
  const client = loadPage(dom, { call: async (path) => { calls.push(path); return { ok: true, data: sample }; } });

  client.editRedirect("old.example.test");
  await client.saveRedirect("old.example.test");

  expect(calls).toEqual([]);
  expect(dom.classes).not.toContain("is-editing");
});

test("a saved edit repaints the row from the server's answer", async () => {
  const dom = fakePage({ domain: "old.example.test", target: "https://www.example.test", code: "301", preserve: "true" });
  const messages: { message: string; kind: string }[] = [];
  let sent: Record<string, unknown> = {};
  const client = loadPage(dom, {
    call: async (path, options) => {
      sent = JSON.parse(options!.body!);
      return {
        ok: true,
        data: {
          redirects: [{
            domain: "old.example.test", target: "https://new.example.test", code: 302,
            preservePath: false, type: "static", applied: true,
          }],
        },
      };
    },
    notify: (message, kind) => messages.push({ message, kind }),
  });

  client.editRedirect("old.example.test");
  dom.parts[".redirect-input"]!.value = "https://new.example.test";
  dom.parts[".redirect-code"]!.value = "302";
  dom.parts[".redirect-preserve"]!.checked = false;
  await client.saveRedirect("old.example.test");

  expect(sent).toEqual({
    domain: "old.example.test", target: "https://new.example.test", code: 302, preservePath: false,
  });
  expect(dom.row.dataset.target).toBe("https://new.example.test");
  expect(dom.parts[".redirect-target-text"]!.textContent).toBe("https://new.example.test");
  expect(dom.parts[".redirect-code-text"]!.textContent).toBe("302 temporary");
  expect(dom.parts[".redirect-path-text"]!.textContent).toBe("Dropped");
  expect(messages).toEqual([
    { message: "old.example.test now sends visitors to https://new.example.test.", kind: "ok" },
  ]);
});

test("a failed edit reports inline and leaves the row's own values alone", async () => {
  const dom = fakePage({ domain: "old.example.test", target: "https://www.example.test", code: "301", preserve: "true" });
  const messages: { message: string; kind: string }[] = [];
  const client = loadPage(dom, {
    call: async () => { throw new Error("nginx refused it"); },
    notify: (message, kind) => messages.push({ message, kind }),
  });

  client.editRedirect("old.example.test");
  dom.parts[".redirect-input"]!.value = "https://broken.example.test";
  await client.saveRedirect("old.example.test");

  expect(messages).toEqual([{ message: "Could not change the redirect: nginx refused it", kind: "error" }]);
  expect(dom.row.dataset.target).toBe("https://www.example.test");
});

test("clearing a redirect asks first and only reloads once the server agreed", async () => {
  const dom = fakePage({ domain: "old.example.test", target: "https://www.example.test", code: "301", preserve: "true" });
  let asked = 0;
  let reloaded = 0;
  const declined = loadPage(dom, {
    call: async () => { throw new Error("should not be called"); },
    confirmAction: async () => { asked += 1; return false; },
    reload: () => { reloaded += 1; },
  });
  await declined.clearRedirect("old.example.test");
  expect([asked, reloaded]).toEqual([1, 0]);

  const accepted = loadPage(dom, {
    call: async () => ({ ok: true, data: { redirects: [] } }),
    confirmAction: async () => true,
    reload: () => { reloaded += 1; },
  });
  await accepted.clearRedirect("old.example.test");
  expect(reloaded).toBe(1);
});

test("the create form refuses an empty domain or target before asking the server", async () => {
  const dom = fakePage({ domain: "old.example.test", target: "https://www.example.test", code: "301", preserve: "true" });
  const messages: { message: string; kind: string }[] = [];
  const calls: string[] = [];
  const client = loadPage(dom, {
    call: async (path) => { calls.push(path); return { ok: true, data: sample }; },
    notify: (message, kind) => messages.push({ message, kind }),
  });

  await client.createRedirect();
  expect(calls).toEqual([]);
  expect(messages).toEqual([{ message: "A domain and a target are both needed.", kind: "warn" }]);

  dom.byId["new-domain"]!.value = " NEW.example.test ";
  dom.byId["new-target"]!.value = "https://www.example.test";
  await client.createRedirect();
  expect(calls).toEqual(["/api/redirects/create"]);
});

test("repair reports a redirect it put back and says nothing when there was none", async () => {
  const fix = fixture();
  try {
    addSite(fix, "old.example.test");
    const { REDIRECTS_ADDON } = await import("../addons/redirects/addon");
    expect(await REDIRECTS_ADDON.maintenance!.run({ paths: fix.paths, domainValidator: normalizeForTest, run: fix.run })).toBeNull();

    await executeRedirectsAction(["set", "--domain=old.example.test"], {
      paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
      input: JSON.stringify({ target: "https://www.example.test", code: 301 }),
    });
    writeFileSync(
      join(fix.paths.nginxVhostDir, "old.example.test.conf"),
      staticTemplate("old.example.test", "siteuser", true),
      { mode: 0o644 },
    );

    expect(await REDIRECTS_ADDON.maintenance!.run({ paths: fix.paths, domainValidator: normalizeForTest, run: fix.run }))
      .toBe("1 redirect put back (old.example.test)");
  } finally {
    cleanup(fix);
  }
});

test("the reconcile result the repair line is built from is the action's own", async () => {
  const fix = fixture();
  try {
    addSite(fix, "a.example.test");
    addSite(fix, "b.example.test");
    for (const domain of ["a.example.test", "b.example.test"]) {
      await executeRedirectsAction([`set`, `--domain=${domain}`], {
        paths: fix.paths, domainValidator: normalizeForTest, run: fix.run,
        input: JSON.stringify({ target: "https://www.example.test", code: 301 }),
      });
      writeFileSync(join(fix.paths.nginxVhostDir, `${domain}.conf`), staticTemplate(domain, "siteuser", true), { mode: 0o644 });
    }
    const result = await executeRedirectsAction(["reconcile"], { paths: fix.paths, domainValidator: normalizeForTest, run: fix.run }) as ReconcileResult;
    expect(result.repaired).toEqual(["a.example.test", "b.example.test"]);
  } finally {
    cleanup(fix);
  }
});
