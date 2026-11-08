// Two addons patching one CloudPanel template.
//
// This is the scenario the previous injector could not survive, and none of it
// was visible with a single addon installed. Pristine state was keyed by the
// addon rather than by the template, so the second addon to install snapshotted
// a file that already held the first addon's block -- stripped as if it were
// its own. Installing B deleted A's nav entry, the two reconciliation timers
// then overwrote each other every fifteen minutes, and uninstalling either one
// removed both because the markers were a module-level constant.
//
// Runs against throwaway templates, never the panel's own.

// The .test.ts suffix keeps this suite in Bun's default discovery set.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { findMasterVhost, inspect, masterVhostHost, NGINX_PROXY_BLOCK, inspectNginxProxy, reconcile, reconcileNginxProxy, type Injection } from "../cli/inject";
import { STAGER_TARGETS } from "../addons/stager/inject/targets";
import { WP_TOOLS_TARGETS } from "../addons/wp-tools/inject/targets";
import { headerTarget, siteLayoutTarget } from "../lib/panel-nav";
import { MAINTENANCE_TARGETS } from "../addons/maintenance/inject/targets";
import type { AddonTarget } from "../lib/addon-target";

// Everything happens under temporary directories: this must not touch the
// panel's templates, must not disturb a real installation's snapshots, and must
// not need root to write under /var/lib.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(`${tmpdir()}/${prefix}`);
  dirs.push(dir);
  return dir;
}

/** A templates directory with one template in it, and a reader for it. */
function templates(name: string, content: string) {
  const dir = tempDir("inject-test-");
  const paths = { templatesDir: dir, stateDir: `${dir}/state` };
  const file = `${dir}/${name}`;
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  writeFileSync(file, content);
  return { dir, paths, read: () => readFileSync(file, "utf-8") };
}

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

const TEMPLATE = "header.html.twig";

test("two addons at one anchor keep each other's blocks and restore the template exactly", () => {
  const ORIGINAL = `<html>\n<div class="nav-link-container w-100">\n</div>\n</html>\n`;
  const { paths, read } = templates(TEMPLATE, ORIGINAL);
  const target = (label: string): AddonTarget => ({
    slug: "nav",
    template: TEMPLATE,
    anchorAfter: '<div class="nav-link-container w-100">',
    required: true,
    snippet: (url) => `\n  <a href="${url}">${label}</a>`,
  });
  const A: Injection = { addon: "alpha", target: target("AlphaNav"), url: "https://a.example.com" };
  const B: Injection = { addon: "bravo", target: target("BravoNav"), url: "https://b.example.com" };

  reconcile([A], paths);
  expect(read()).toContain("AlphaNav");
  expect(read()).not.toContain("BravoNav");

  reconcile([A, B], paths);
  expect(read()).toContain("AlphaNav");
  expect(read()).toContain("BravoNav");

  // The reconciliation timers run independently and repeatedly.
  for (let i = 0; i < 3; i++) reconcile([A, B], paths);
  const settled = read();
  reconcile([A, B], paths);
  expect(read()).toBe(settled);
  expect(count(read(), /AlphaNav/g)).toBe(1);
  expect(count(read(), /BravoNav/g)).toBe(1);

  // Uninstalling one addon is reconciling without it.
  reconcile([B], paths);
  expect(read()).not.toContain("AlphaNav");
  expect(read()).toContain("BravoNav");
  reconcile([B], paths);
  expect(read()).toContain("BravoNav");

  // Uninstalling the last addon restores the template exactly.
  reconcile([], paths);
  expect(read()).toBe(ORIGINAL);
  expect(existsSync(paths.stateDir) ? readdirSync(paths.stateDir) : []).toEqual([]);
});

test("the manager's header entry follows the native links, once, with the update notice", () => {
  const navOriginal = `<div class="nav-link-container w-100"><a>Dashboard</a>${headerTarget().anchorAfter}</div>`;
  const { paths, read } = templates(TEMPLATE, navOriginal);
  const manager: Injection = { addon: "manager", target: { ...headerTarget(), template: TEMPLATE }, url: "/addons/" };
  reconcile([manager], paths);
  const body = read();
  expect(body.indexOf("Dashboard")).toBeLessThan(body.indexOf("clp_sites"));
  expect(body.indexOf("clp_sites")).toBeLessThan(body.indexOf("clp-addon-nav"));
  expect(body).toContain(">Addons</a>");
  expect(body).not.toContain('class="nav-link"');
  expect(body).toContain("clp-addon-update-badge");
  expect(body).toContain("window.__clpAddonsUpdateInit");

  reconcile([manager], paths);
  expect(count(read(), /class="clp-addon-nav"/g)).toBe(1);
});

test("installing and uninstalling addons one and two at a time keeps one manager entry", () => {
  const navOriginal = `<div class="nav-link-container w-100"><a>Dashboard</a>${headerTarget().anchorAfter}</div>`;
  const { dir, paths, read: header } = templates(TEMPLATE, navOriginal);
  const instaticTemplate = "instatic.html.twig";
  const instaticOriginal = '<div class="site-list"><!-- instatic-anchor --></div>';
  writeFileSync(`${dir}/${instaticTemplate}`, instaticOriginal);
  const stagerTemplate = "stager.html.twig";
  const stagerOriginal = '<div class="actions"><!-- stager-anchor --></div>';
  writeFileSync(`${dir}/${stagerTemplate}`, stagerOriginal);
  const instatic = () => readFileSync(`${dir}/${instaticTemplate}`, "utf-8");
  const stager = () => readFileSync(`${dir}/${stagerTemplate}`, "utf-8");
  const managerEntries = () => count(header(), /class="clp-addon-nav"/g);

  const installed = (names: string[], exclude?: string): Injection[] => {
    const active = names.filter((name) => name !== exclude);
    const injections: Injection[] = [];
    if (active.length > 0) {
      injections.push({ addon: "manager", target: { ...headerTarget(), template: TEMPLATE }, url: "/addons/" });
    }
    if (active.includes("instatic")) {
      injections.push({ addon: "instatic", target: { slug: "new-site", template: instaticTemplate, anchorAfter: "<!-- instatic-anchor -->", required: false, snippet: (url) => `<span>Instatic at ${url}</span>` }, url: "/addons/instatic" });
    }
    if (active.includes("stager")) {
      injections.push({ addon: "stager", target: { slug: "site-action", template: stagerTemplate, anchorBefore: "<!-- stager-anchor -->", required: false, snippet: (url) => `<span>Stager at ${url}</span>` }, url: "/addons/stager" });
    }
    return injections;
  };

  reconcile(installed(["instatic"]), paths);
  expect(header()).toContain(">Addons</a>");
  expect(instatic()).toContain("Instatic at /addons/instatic");
  expect(stager()).toBe(stagerOriginal);

  reconcile(installed(["instatic", "stager"]), paths);
  expect(managerEntries()).toBe(1);
  expect(instatic()).toContain("Instatic at /addons/instatic");
  expect(stager()).toContain("Stager at /addons/stager");
  expect(stager().indexOf("Stager at /addons/stager")).toBeLessThan(stager().indexOf("<!-- stager-anchor -->"));

  reconcile(installed(["instatic", "stager"], "instatic"), paths);
  expect(managerEntries()).toBe(1);
  expect(instatic()).toBe(instaticOriginal);
  expect(stager()).toContain("Stager at /addons/stager");

  reconcile(installed(["stager"], "stager"), paths);
  expect(header()).toBe(navOriginal);
  expect(stager()).toBe(stagerOriginal);

  reconcile(installed(["stager"]), paths);
  expect(header()).toContain(">Addons</a>");
  expect(stager()).toContain("Stager at /addons/stager");
  reconcile(installed(["stager"], "stager"), paths);
  expect(header()).toBe(navOriginal);
  expect(stager()).toBe(stagerOriginal);
});

// WP_TOOLS_TARGETS puts its link before the Manage link in the sites table's
// action cell, which is the project's one anchor inside a Twig loop.
test("the WordPress Tools site action lands before the panel's Manage link, in the row's own site", () => {
  // By slug, not by index: this addon has more than one target and their order
  // in the list is the injector's business, not this fixture's.
  const siteActionTarget = WP_TOOLS_TARGETS.find((target) => target.slug === "sites-action")!;
  const siteOriginal = `
                    <td class="text-end">
                      <a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>
                    </td>
`;
  const { paths, read } = templates(siteActionTarget.template, siteOriginal);
  const injection: Injection = { addon: "wp-tools", target: siteActionTarget, url: "/addons/wp-tools" };

  expect(inspect(injection, paths).state).toBe("missing-anchor");
  reconcile([injection], paths);
  const login = read().indexOf("WP Login</a>");
  expect(login).not.toBe(-1);
  expect(login).toBeLessThan(read().indexOf("Manage{% endtrans %}</a>"));
  expect(read()).toContain("{{ site.domainName }}");
  expect(inspect(injection, paths).state).toBe("ok");

  reconcile([injection], paths);
  expect(count(read(), /WP Login<\/a>/g)).toBe(1);

  reconcile([], paths);
  expect(read()).toBe(siteOriginal);
});

test("several blocks before one anchor go in alphabetical order and come out exactly", () => {
  const template = "multi-before.html.twig";
  const original = `<div><!-- anchor --></div>\n`;
  const { paths, read } = templates(template, original);
  const button = (addon: string, label: string): Injection => ({
    addon,
    target: { slug: "btn", template, anchorBefore: "<!-- anchor -->", required: false, snippet: () => `<button>${label}</button>` },
    url: `/addons/${addon}`,
  });
  reconcile([button("bravo", "Bravo"), button("alpha", "Alpha")], paths);
  const alpha = read().indexOf("<button>Alpha</button>");
  const bravo = read().indexOf("<button>Bravo</button>");
  expect(alpha).not.toBe(-1);
  expect(alpha).toBeLessThan(bravo);
  expect(bravo).toBeLessThan(read().indexOf("<!-- anchor -->"));

  reconcile([], paths);
  expect(read()).toBe(original);
});

const NGINX_ORIGINAL = `server {\n    listen 8443 ssl;\n    server_name panel.example.test;\n}\n`;

test("the Nginx proxy goes in through the enabled-site link, refuses drift and comes out cleanly", () => {
  expect(NGINX_PROXY_BLOCK).toContain("proxy_set_header X-Forwarded-Host $http_host;");
  // CloudPanel's vhost has a regex location for static file extensions, and
  // nginx tests regex locations before a prefix match wins. Without ^~ every
  // addon URL ending in .js or .css is served from the filesystem as a 404.
  expect(NGINX_PROXY_BLOCK).toContain("location ^~ /addons/ {");

  const dir = tempDir("nginx-test-");
  const source = `${dir}/cloudpanel.conf`;
  const link = `${dir}/enabled.conf`;
  const state = `${dir}/state`;
  writeFileSync(source, NGINX_ORIGINAL);
  symlinkSync(source, link);

  const result = reconcileNginxProxy({ vhostPath: link, stateDir: state, reload: false });
  expect(result.state).toBe("ok");
  expect(readFileSync(source, "utf-8")).toContain(NGINX_PROXY_BLOCK);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(inspectNginxProxy({ vhostPath: link, stateDir: state }).state).toBe("ok");

  const managed = readFileSync(source, "utf-8");
  const rollback = () => ["vhost.pristine", "vhost.sha256", "vhost.path"].map((name) => readFileSync(`${state}/${name}`, "utf-8"));
  const rollbackBefore = rollback();
  const updated = NGINX_ORIGINAL.replace("panel.example.test", "panel-updated.example.test");
  writeFileSync(source, updated);
  const drift = reconcileNginxProxy({ vhostPath: link, stateDir: state, reload: false });
  expect(drift.state).toBe("upstream-changed");
  expect(drift.changed).toBe(false);
  expect(drift.detail).toContain("no changes were made");
  expect(readFileSync(source, "utf-8")).toBe(updated);
  expect(rollback()).toEqual(rollbackBefore);
  expect(inspectNginxProxy({ vhostPath: link, stateDir: state }).state).toBe("upstream-changed");

  writeFileSync(source, managed);
  const removed = reconcileNginxProxy({ vhostPath: link, stateDir: state, enabled: false, reload: false });
  expect(removed.changed).toBe(true);
  expect(readFileSync(source, "utf-8")).toBe(NGINX_ORIGINAL);
  expect(existsSync(`${state}/vhost.pristine`)).toBe(false);
  expect(existsSync(`${state}/vhost.sha256`)).toBe(false);
});

const CUSTOMER_VHOST = `server {\n    listen 8443 ssl;\n    server_name customer.example.test;\n    root /home/clp/htdocs/customer;\n}\n`;

/** Runs `fn` with no vhost override in the environment, so discovery is what is tested. */
function withoutVhostOverride<T>(fn: () => T): T {
  const saved = process.env.CLP_ADDONS_NGINX_VHOST;
  delete process.env.CLP_ADDONS_NGINX_VHOST;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.CLP_ADDONS_NGINX_VHOST;
    else process.env.CLP_ADDONS_NGINX_VHOST = saved;
  }
}

test("Nginx discovery uses CloudPanel's fixed vhost filename and leaves customer vhosts alone", () => {
  const dir = tempDir("nginx-discovery-test-");
  writeFileSync(`${dir}/cloudpanel.conf`, NGINX_ORIGINAL);
  writeFileSync(`${dir}/customer.conf`, CUSTOMER_VHOST);
  withoutVhostOverride(() => {
    expect(findMasterVhost({ sitesDir: dir })).toBe(`${dir}/cloudpanel.conf`);
    expect(reconcileNginxProxy({ sitesDir: dir, stateDir: `${dir}/state`, reload: false }).state).toBe("ok");
  });
  expect(readFileSync(`${dir}/customer.conf`, "utf-8")).toBe(CUSTOMER_VHOST);
});

test("Nginx discovery refuses an ambiguous master vhost and changes nothing", () => {
  const dir = tempDir("nginx-ambiguous-test-");
  const ambiguous = `${NGINX_ORIGINAL}\n${NGINX_ORIGINAL.replace("panel.example.test", "panel-https.example.test")}`;
  writeFileSync(`${dir}/cloudpanel.conf`, ambiguous);
  writeFileSync(`${dir}/customer.conf`, CUSTOMER_VHOST);
  const result = withoutVhostOverride(() => reconcileNginxProxy({ sitesDir: dir, stateDir: `${dir}/state`, reload: false }));
  expect(result.state).toBe("ambiguous");
  expect(result.changed).toBe(false);
  expect(result.detail).toContain("2 server blocks");
  expect(readFileSync(`${dir}/cloudpanel.conf`, "utf-8")).toBe(ambiguous);
  expect(readFileSync(`${dir}/customer.conf`, "utf-8")).toBe(CUSTOMER_VHOST);
  expect(existsSync(`${dir}/state`)).toBe(false);
});

test("Nginx discovery fails closed when the fixed master vhost is absent", () => {
  const dir = tempDir("nginx-missing-master-test-");
  writeFileSync(`${dir}/customer.conf`, CUSTOMER_VHOST);
  const result = withoutVhostOverride(() => reconcileNginxProxy({ sitesDir: dir, stateDir: `${dir}/state`, reload: false }));
  expect(result.state).toBe("missing");
  expect(result.detail).toContain("cloudpanel.conf");
  expect(readFileSync(`${dir}/customer.conf`, "utf-8")).toBe(CUSTOMER_VHOST);
  expect(existsSync(`${dir}/state`)).toBe(false);
});

/** Runs `fn` with an `nginx` on PATH whose configuration test always fails. */
function withFailingNginx<T>(dir: string, fn: () => T): T {
  mkdirSync(`${dir}/bin`);
  writeFileSync(`${dir}/bin/nginx`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}/bin:${saved ?? ""}`;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

test("a failed Nginx validation puts back the pristine vhost", () => {
  const dir = tempDir("nginx-failure-test-");
  const vhost = `${dir}/cloudpanel.conf`;
  writeFileSync(vhost, NGINX_ORIGINAL);
  const result = withFailingNginx(dir, () => reconcileNginxProxy({ vhostPath: vhost, stateDir: `${dir}/state` }));
  expect(result.state).toBe("validation-failed");
  expect(readFileSync(vhost, "utf-8")).toBe(NGINX_ORIGINAL);
});

test("a failed Nginx validation on removal puts back the active proxy", () => {
  const dir = tempDir("nginx-disable-failure-test-");
  const vhost = `${dir}/cloudpanel.conf`;
  const withProxy = `${NGINX_ORIGINAL.trimEnd()}\n${NGINX_PROXY_BLOCK}\n`;
  writeFileSync(vhost, withProxy);
  const result = withFailingNginx(dir, () => reconcileNginxProxy({ vhostPath: vhost, stateDir: `${dir}/state`, enabled: false }));
  expect(result.state).toBe("validation-failed");
  expect(readFileSync(vhost, "utf-8")).toBe(withProxy);
});

// Adversarial cases for the master-vhost server-block scanner: a `#` comment
// or a quoted string can contain characters that look like Nginx structure
// (braces, even the word "server") without being real config, and a whole
// server block can itself be commented out. None of that may confuse block
// discovery, brace matching, or the `listen 8443` / `server_name` checks that
// pick the one real CloudPanel server block out of the file.

/** A master vhost with `content`, the host found in it, and the result of injecting into it. */
function scanned(content: string) {
  const dir = tempDir("nginx-scanner-test-");
  const vhost = `${dir}/cloudpanel.conf`;
  const state = `${dir}/state`;
  writeFileSync(vhost, content);
  const host = masterVhostHost({ vhostPath: vhost });
  const result = reconcileNginxProxy({ vhostPath: vhost, stateDir: state, reload: false });
  return { host, result, after: readFileSync(vhost, "utf-8"), stateLeft: existsSync(state) };
}

const injectedAtEnd = (content: string) => `${content.slice(0, -2)}\n${NGINX_PROXY_BLOCK}\n}\n`;

for (const { label, content } of [
  // A `}` inside a `#` comment must not close the server block early -- the
  // content after it (here, `server_name`) is still inside the real block.
  {
    label: "a closing brace inside a comment",
    content: "server {\n    listen 8443 ssl;\n" +
      "    # a stray closing brace in a comment: } must not end the block early\n" +
      "    server_name panel.example.test;\n}\n",
  },
  {
    label: "a closing brace inside a quoted string",
    content: "server {\n    listen 8443 ssl;\n    server_name panel.example.test;\n" +
      '    add_header X-Note "a brace in a string: } does not close anything";\n}\n',
  },
  {
    label: "nested location blocks",
    content: "server {\n    listen 8443 ssl;\n    server_name panel.example.test;\n" +
      "    location / {\n        try_files $uri $uri/ =404;\n    }\n" +
      "    location /api/ {\n        proxy_pass http://127.0.0.1:3000;\n    }\n}\n",
  },
  // A quoted string ending in an escaped backslash must still close at its own
  // closing quote. If the string is treated as still open, the next quote on
  // the line looks like an opener, and characters after it -- including a `}`
  // -- leak out as if they were real config. That truncates the server block
  // mid-directive, so `server_name` falls outside it and the proxy block gets
  // spliced into the middle of an `add_header` line.
  {
    label: "an escaped backslash before a closing quote",
    content: "server {\n    listen 8443 ssl;\n" +
      '    add_header X-Note "C:\\\\" "}";\n' +
      "    server_name panel.example.test;\n}\n",
  },
]) {
  test(`${label} does not end the server block early`, () => {
    const { host, result, after } = scanned(content);
    expect(host).toBe("panel.example.test");
    expect(result.state).toBe("ok");
    expect(after).toBe(injectedAtEnd(content));
  });
}

// An unterminated quote ending in a dangling backslash must not swallow the
// rest of the file: the string ends at the newline, as Nginx treats it.
test("an unterminated string ending in a backslash ends at the newline, not at the next quote", () => {
  const { host } = scanned("server {\n    listen 8443 ssl;\n" +
    '    add_header X-Broken "unterminated \\\\\n' +
    "    server_name panel.example.test;\n}\n");
  expect(host).toBe("panel.example.test");
});

for (const { label, content, detail } of [
  // A `listen 8443` that only appears because the whole server block is
  // commented out must not count as a match: the master vhost has zero real
  // server blocks listening on 8443, which is ambiguous (fails closed), not a
  // false-positive single match on commented-out text.
  {
    label: "inside a commented-out server block",
    content: "# server {\n#     listen 8443 ssl;\n#     server_name fake.example.test;\n# }\n" +
      "server {\n    listen 80;\n    server_name real.example.test;\n}\n",
    detail: "no server block listening on port 8443",
  },
  // The masker also hides directive *text*, not just braces.
  {
    label: "inside a quoted string",
    content: "server {\n    listen 80;\n" +
      '    add_header X-Note "listen 8443 ssl";\n' +
      "    server_name real.example.test;\n}\n",
    detail: "",
  },
]) {
  test(`a listen 8443 that only exists ${label} is not a match, and nothing changes`, () => {
    const { host, result, after, stateLeft } = scanned(content);
    expect(host).toBeNull();
    expect(result.state).toBe("ambiguous");
    expect(result.changed).toBe(false);
    if (detail) expect(result.detail).toContain(detail);
    expect(after).toBe(content);
    expect(stateLeft).toBe(false);
  });
}

// The site tab strip carries blocks from several owners: the addons' tabs, and
// the manager's rule that keeps the strip on one row once a tab is there.
test("the site tab strip takes the one-row rule and both tabs, in a stable order", () => {
  const tabTemplate = "tab-container.html.twig";
  const tabOriginal = `<div class="tab-container">
  <ul>
    <li>
      <a href="{{ path('clp_site_logs', {'domainName': site.domainName}) }}">{% trans %}Logs{% endtrans %}</a>
    </li>
  </ul>
</div>
`;
  const { paths, read } = templates(tabTemplate, tabOriginal);
  const stagerTabTarget = STAGER_TARGETS.find((target) => target.slug === "site-tab")!;
  const injections: Injection[] = [
    { addon: "manager", target: { ...siteLayoutTarget(), template: tabTemplate }, url: "/addons/" },
    { addon: "maintenance", target: { ...MAINTENANCE_TARGETS[0]!, template: tabTemplate }, url: "/addons/maintenance" },
    { addon: "stager", target: { ...stagerTabTarget, template: tabTemplate }, url: "/addons/stager" },
  ];
  reconcile(injections, paths);
  const body = read();
  expect(body).toContain("flex-wrap: nowrap");
  expect(body).toContain(">Maintenance</a>");
  expect(body).toContain(">Staging</a>");
  // The order ADDON_SITE_TABS gives the reproduced strip, so the panel's copy
  // and the addon's own copy of it read the same left to right.
  expect(body.indexOf(">Maintenance</a>")).toBeLessThan(body.indexOf(">Staging</a>"));
  // The one-row rule is applied before the strip it styles.
  expect(body.indexOf("flex-wrap: nowrap")).toBeLessThan(body.indexOf('<div class="tab-container">'));
  // The addon tab stays inside the panel's own admin guard.
  expect(body.indexOf("{% if is_granted('ROLE_ADMIN') %}")).toBeLessThan(body.indexOf(">Maintenance</a>"));

  reconcile(injections, paths);
  const settled = read();
  expect(count(settled, /flex-wrap: nowrap/g)).toBe(1);
  expect(count(settled, />Maintenance<\/a>/g)).toBe(1);
  expect(count(settled, />Staging<\/a>/g)).toBe(1);
  // Two addons at one anchor must not swap places on every pass, or the file
  // never settles and the panel's Twig cache is rebuilt forever.
  reconcile(injections, paths);
  expect(read()).toBe(settled);

  // Removing the addons removes the rule that only existed for their tabs.
  reconcile([], paths);
  expect(read()).toBe(tabOriginal);
});
