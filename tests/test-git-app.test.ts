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
