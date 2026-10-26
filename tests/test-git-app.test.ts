import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { appRequest as request } from "./app-request";
import { handle as gitHandle } from "../addons/git/app/index";
import { gitService, type GitSiteStatus } from "../addons/git/app/service";
import { siteView, fleetView } from "../addons/git/app/views";

afterEach(() => mock.restore());

const site: GitSiteStatus = {
  domain: "www.example.com", siteUser: "example", siteType: "php", path: "/home/example/htdocs/www.example.com",
  configured: true, publicKey: "ssh-ed25519 preview", commit: null, lastJob: null,
  config: {
    domain: "www.example.com", remote: "git@example.test:example/site.git", branch: "main", directory: "",
    postDeploy: "", updatedAt: "", webhook: null,
  },
};

function gitReader() {
  return spyOn(gitService, "site").mockResolvedValue({
    site, context: { domain: site.domain, user: site.siteUser, type: site.siteType, varnishCache: false },
  });
}

describe("Git view replies", () => {
  const cases = [
    ["config", "PUT", { remote: site.config!.remote, branch: "main" }, "configure"],
    ["config", "DELETE", undefined, "forget"],
    ["key", "POST", { replace: false }, "generateKey"],
    ["key", "POST", { replace: true }, "generateKey"],
    ["webhook", "POST", {}, "setWebhook"],
    ["webhook", "POST", { replace: true }, "setWebhook"],
    ["webhook", "DELETE", undefined, "setWebhook"],
  ] as const;

  for (const [action, method, body, service] of cases) {
    test(`${method} ${action} ${JSON.stringify(body)} returns the first-load renderer and keeps its data`, async () => {
      const read = gitReader();
      const change = spyOn(gitService, service).mockResolvedValue({ ok: true, data: {} } as never);
      const path = `/api/sites/${site.domain}/${action}`;
      const response = await gitHandle(request(path, method, body), path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, data: {}, html: siteView(site, "") });
      expect(read).toHaveBeenCalledTimes(1);
      expect(change).toHaveBeenCalledTimes(1);
    });
  }

  test("view API renders both the fleet and the embedded site without redirecting", async () => {
    gitReader();
    spyOn(gitService, "listSites").mockResolvedValue([site]);
    for (const [query, html] of [["", fleetView([site])], [`?domain=${site.domain}`, siteView(site, "")]]) {
      const response = await gitHandle(request("/api/view" + query), "/api/view");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, html });
    }
    expect((await gitHandle(request("/api/view?domain=bad"), "/api/view")).status).toBe(400);
  });

  test("a change that landed still succeeds when its view cannot be read", async () => {
    spyOn(gitService, "site").mockRejectedValue(new Error("panel info unavailable"));
    spyOn(gitService, "forget").mockResolvedValue({ ok: true, data: {} } as never);
    const path = `/api/sites/${site.domain}/config`;
    const response = await gitHandle(request(path, "DELETE"), path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: {} });
  });

  test("the site page names its site for the repaint, and the fleet page names none", () => {
    expect(siteView(site, "")).toContain(`data-git-domain="${site.domain}"`);
    expect(fleetView([site])).not.toContain("data-git-domain");
  });

  test("rejected and unguarded changes have no view and do not read status", async () => {
    const read = gitReader();
    const change = spyOn(gitService, "forget").mockResolvedValue({ ok: false, error: "refused" });
    const path = `/api/sites/${site.domain}/config`;
    const rejected = await gitHandle(request(path, "DELETE"), path);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ ok: false, error: "refused" });
    const denied = await gitHandle(request(path, "DELETE", undefined, false), path);
    expect(denied.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(change).toHaveBeenCalledTimes(1);
  });
});

describe("Git pages", () => {
  const job = {
    id: "20260917T110500Z-ab12cd", kind: "deploy", domain: site.domain, startedBy: "push", state: "failed",
    step: "", error: "the post-deploy command failed", createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    startedAt: "", finishedAt: "", result: null,
  };

  test("one status card holds the checkout, the last deployment and Deploy now", () => {
    const html = siteView({ ...site, lastJob: job }, "log");
    const card = html.slice(html.indexOf('id="git-job-card"'), html.indexOf("git-settings"));
    expect(card).toContain('<span class="badge state-failed" id="job-state">Failed</span>');
    expect(card).toMatch(/4 minutes ago<\/time> · push/);
    expect(card).toContain('id="git-deploy"');
    expect(card).toContain('<pre id="job-log">log</pre>');
    expect(html).not.toContain("Deployment mode");
    expect(html).not.toContain("Latest deployment");
  });

  test("settings are one card of rows, the missing key first and open, the push switch on its row", () => {
    const missing = siteView({ ...site, publicKey: "" }, "");
    const settings = missing.slice(missing.indexOf("git-settings"));
    expect(settings.indexOf('id="git-deploy-key" open')).toBeGreaterThan(-1);
    expect(settings.indexOf('id="git-deploy-key"')).toBeLessThan(settings.indexOf('id="git-repository-settings"'));
    expect(settings).toContain('<div class="git-push-row">');
    expect(missing).not.toContain("git-dashboard");
    expect(missing).not.toContain("git-disclosure");

    const keyed = siteView({ ...site, commit: { hash: "a", shortHash: "a", author: "", committedAt: "", subject: "x" } }, "");
    expect(keyed.indexOf('id="git-repository-settings"')).toBeLessThan(keyed.indexOf('id="git-deploy-key"'));
    expect(keyed).not.toContain('id="git-deploy-key" open');

    const hooked = siteView({ ...site, config: { ...site.config!, webhook: { token: "A".repeat(43), lastDeliveryAt: "", lastDelivery: "", lastDeliveryJob: "" } } }, "");
    expect(hooked).toMatch(/<details class="disclosure git-push" id="git-webhook-setup">\s*<summary>.*Push to deploy.*id="git-webhook-toggle" type="checkbox" checked/s);
  });

  test("every repository field shows at once, and Stop deploying sits beside Save changes", () => {
    const html = siteView(site, "");
    expect(html).not.toContain("git-advanced");
    for (const id of ["git-remote", "git-branch", "git-post-deploy", "git-directory"]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/<div class="form-actions">\s*<button class="btn btn-danger"[^>]*>Stop deploying<\/button>\s*<button class="btn btn-primary" type="submit">Save changes/);
  });

  test("the fleet names the sites that need attention, and says nothing when none do", () => {
    expect(fleetView([site])).not.toContain("Needs attention");
    const html = fleetView([
      { ...site, lastJob: job },
      { ...site, domain: "key.example.com", keyMissing: true },
      { ...site, domain: "push.example.com", config: { ...site.config!, webhook: { token: "", lastDeliveryAt: "x", lastDelivery: "ignored: a deployment of push.example.com is already running", lastDeliveryJob: "" } } },
      { ...site, domain: "branch.example.com", config: { ...site.config!, webhook: { token: "", lastDeliveryAt: "x", lastDelivery: "ignored: the push was for refs/heads/dev, not main", lastDeliveryJob: "" } } },
    ]);
    expect(html).toContain("Needs attention: www.example.com (the last deployment failed), key.example.com (its deploy key is missing), push.example.com (the last push was not deployed).");
    expect(html).not.toContain("git-metric");
    // The shared selection drives the bulk button.
    expect(html).toContain('data-needs-selection disabled onclick="deployGitSelected()"');
    expect(html).toContain('onclick="toggleSiteSelection(event, this)"');
  });
});
