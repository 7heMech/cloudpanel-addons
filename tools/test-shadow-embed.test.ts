import { expect, test } from "bun:test";
import { handle as handleMaintenance } from "../addons/maintenance/app/index";
import { maintenanceService } from "../addons/maintenance/app/service";
import { fragment } from "../addons/maintenance/app/views";
import { BASE_STYLE } from "../lib/app-ui";
import { siteLayoutTarget } from "../lib/panel-nav";
import { EMBED_MARKER, embedLandingUrl, shadowStyle, SITE_EMBED_SCRIPT } from "../lib/shadow-embed";

test("the stylesheet is rewritten for a shadow root", () => {
  const css = shadowStyle(BASE_STYLE);
  // A shadow tree cannot select the document, so the host carries both.
  expect(css).not.toContain(":root {");
  expect(css).not.toMatch(/(^|\n)html\.dark/);
  expect(css).toContain(":host {");
  expect(css).toContain(":host(.dark) {");
  expect(css).toContain(":host(.dark) .card-header");
  // The document belongs to CloudPanel on an embedded page.
  expect(css).not.toMatch(/(^|\n)body \{/);
  expect(css).toContain(":host { display: block;");
  // Rules an addon adds are rewritten too, including the editor's dark tint.
  expect(shadowStyle(BASE_STYLE + "\nhtml.dark #template-ace { background:#000; }"))
    .toContain(":host(.dark) #template-ace");
  // Everything else is the shell unchanged.
  expect(css).toContain(".switch input:checked + span");
  expect(css).toContain(".card {");
});

test("a fragment is a page with no document around it", () => {
  const page = fragment("Maintenance — shop.example.test", "<p>content</p>");
  expect(page.ok).toBe(true);
  expect(page.title).toBe("Maintenance — shop.example.test");
  expect(page.html).toContain("<p>content</p>");
  // The panel draws the chrome; the fragment must not draw it again.
  expect(page.html).not.toContain("<html");
  expect(page.html).not.toContain("clp-addon-header");
  expect(page.html).not.toContain("clp-addon-footer");
  expect(page.html).not.toContain("clp-addon-tabs");
  expect(page.css).not.toContain("clp-addon-site-info");
  // The shared notice holder and the one confirmation still travel with it.
  expect(page.html.match(/id="clp-flash"/g)).toHaveLength(1);
  expect(page.html.match(/id="clp-confirm"/g)).toHaveLength(1);
  // The script is handed over unrun, and learns its root from the loader.
  expect(page.script).toContain('const CLP_BASE = "/addons/maintenance"');
  expect(page.script).toContain("typeof CLP_MOUNT === 'undefined' ? document : CLP_MOUNT");
  expect(page.script).toContain("CLP_ROOT.getElementById('clp-flash')");
});

test("the loader mounts into a shadow root and runs the script at global scope", () => {
  const script = SITE_EMBED_SCRIPT;
  expect(script).toContain('attachShadow({ mode: "open" })');
  // Inline handlers in the markup resolve against the global scope, so the
  // fragment's script cannot be run inside a closure.
  expect(script).toContain('document.createElement("script")');
  expect(script).not.toContain("new Function(");
  expect(script).toContain("window.CLP_MOUNT = root");
  // One document, one mount: the script declares its helpers once.
  expect(script).toContain("if (mounted) return;");
  expect(script).toContain('history[push ? "pushState" : "replaceState"]');
  // Anything it cannot do falls back to the standalone page. Falling back to
  // the tab link would bounce through the redirect and land here again.
  expect(script).toContain('"embed=0"');
  expect(script).toContain("if (!Element.prototype.attachShadow) return standalone(href);");
  expect(script).not.toMatch(/location\.href = href;/);
  expect(script).toContain(`get("${EMBED_MARKER}")`);
});

test("the loader is injected with the layout rule, behind the same deferral", () => {
  const snippet = siteLayoutTarget().snippet("/addons/");
  expect(snippet).toContain("attachShadow");
  expect(snippet).toContain('document.addEventListener("DOMContentLoaded", start, { once: true })');
  // One script element, one deferral, both bodies inside it.
  expect(snippet.match(/<script>/g)).toHaveLength(1);
  expect(snippet.indexOf("function start()")).toBeLessThan(snippet.indexOf("attachShadow"));
});

test("a deep link into a site's addon page is answered by the panel's own page", async () => {
  const url = "https://panel.example.test:8443/addons/maintenance?domain=shop.example.test";
  const redirect = await handleMaintenance(new Request(url), "/");
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("Location")).toBe(embedLandingUrl("shop.example.test", "maintenance"));
  expect(redirect.headers.get("Location")).toContain(`${EMBED_MARKER}=maintenance`);

  // The standalone page stays reachable, for comparison and for a browser that
  // never reaches the loader.
  const standalone = await handleMaintenance(new Request(`${url}&embed=0`), "/");
  expect(standalone.status).not.toBe(302);
});

test("the fragment route answers with the page and the CSRF cookie its actions echo", async () => {
  const original = {
    globalStatus: maintenanceService.globalStatus,
    site: maintenanceService.site,
    template: maintenanceService.template,
  };
  try {
    maintenanceService.globalStatus = async () => false;
    maintenanceService.site = async (domain: string) => ({
      site: { domain, type: "php", user: "shop", enabled: false, customTemplate: false, bypasses: [] },
      context: { domain, user: "shop", type: "php" },
    });
    maintenanceService.template = async (domain: string) => ({
      ok: true as const,
      data: { domain, custom: false, html: "<html></html>" },
    });

    const res = await handleMaintenance(
      new Request("https://panel.example.test:8443/addons/maintenance/fragment?domain=shop.example.test"),
      "/fragment",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("clp_addons_csrf=");
    const body = await res.json() as { ok: boolean; title: string; css: string; html: string; script: string };
    expect(body.ok).toBe(true);
    expect(body.title).toBe("Maintenance — shop.example.test");
    expect(body.css).toContain(":host {");
    expect(body.html).toContain("shop.example.test");
    expect(body.script).toContain("CLP_ROOT");

    const invalid = await handleMaintenance(
      new Request("https://panel.example.test:8443/addons/maintenance/fragment?domain=not%20a%20host"),
      "/fragment",
    );
    expect(invalid.status).toBe(400);
  } finally {
    Object.assign(maintenanceService, original);
  }
});
