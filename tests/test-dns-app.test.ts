import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { handle } from "../addons/dns/app/index";
import { dnsService } from "../addons/dns/app/service";
import { appRequest } from "./app-request";

afterEach(() => mock.restore());

const readiness = { managed: true, ready: true, reason: "DNS is in place", certificateNames: ["example.com"] };

test("provision scopes non-administrators to the authenticated account and returns readiness only", async () => {
  const provision = spyOn(dnsService, "provision").mockResolvedValue({ ok: true, data: readiness });
  const state = spyOn(dnsService, "state");
  for (const role of ["ROLE_USER", "ROLE_SITE_MANAGER"]) {
    const req = appRequest("/api/provision", "POST", { domain: "example.com", asUser: "admin", ssl: true });
    const response = await handle(req, "/api/provision", undefined, undefined, { user: "bob", roles: [role] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: readiness });
    expect(provision).toHaveBeenLastCalledWith("example.com", { asUser: "bob", ssl: true });
  }
  expect(state).not.toHaveBeenCalled();
});

test("provision returns zoneCreated and nameservers for non-administrators without reading full state", async () => {
  const created = {
    managed: true,
    ready: false,
    reason: "Zone newsite.example was just created; set its nameservers at the registrar: ns1.example.net, ns2.example.net",
    zone: "newsite.example",
    nameServers: ["ns1.example.net", "ns2.example.net"],
    provider: "powerdns" as const,
    zoneCreated: true,
    certificateNames: [],
  };
  const provision = spyOn(dnsService, "provision").mockResolvedValue({ ok: true, data: created });
  const state = spyOn(dnsService, "state");
  for (const role of ["ROLE_USER", "ROLE_SITE_MANAGER"]) {
    const req = appRequest("/api/provision", "POST", { domain: "newsite.example", ssl: true });
    const response = await handle(req, "/api/provision", undefined, undefined, { user: "bob", roles: [role] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: created });
    expect(provision).toHaveBeenLastCalledWith("newsite.example", { asUser: "bob", ssl: true });
  }
  expect(state).not.toHaveBeenCalled();
});

test("provision requires a session and the mutation guard before requesting root work", async () => {
  const provision = spyOn(dnsService, "provision");
  const req = () => appRequest("/api/provision", "POST", { domain: "example.com" });
  expect((await handle(req(), "/api/provision")).status).toBe(404);
  const unguarded = appRequest("/api/provision", "POST", { domain: "example.com" }, false);
  expect((await handle(unguarded, "/api/provision", undefined, undefined, { user: "bob", roles: ["ROLE_USER"] })).status).toBe(403);
  expect(provision).not.toHaveBeenCalled();
});

test("panel-host-helper returns local helper state over GET /api/panel-host-helper", async () => {
  const payload = {
    connected: true,
    automatic: false,
    hasCloudflare: true,
    hasPowerDns: false,
    zones: ["example.com"],
    zoneProviders: { "example.com": "cloudflare" as const },
    panelHost: "panel.example.com",
    serverIps: { ipv4: "203.0.113.10", ipv6: "2001:db8::10" },
  };
  const helper = spyOn(dnsService, "panelHostHelper").mockResolvedValue({ ok: true, data: payload });
  const response = await handle(new Request("http://127.0.0.1/api/panel-host-helper"), "/api/panel-host-helper");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, data: payload });
  expect(helper).toHaveBeenCalledTimes(1);
});

test("POST /api/panel-host forwards prepareOnly to set-panel-host with mutation guard", async () => {
  const change = spyOn(dnsService, "change").mockResolvedValue({ ok: false, error: "Add a Cloudflare connection first" });
  const unguarded = appRequest("/api/panel-host", "POST", { name: "panel.example.com", prepareOnly: true }, false);
  expect((await handle(unguarded, "/api/panel-host")).status).toBe(403);
  expect(change).not.toHaveBeenCalled();

  const req = appRequest("/api/panel-host", "POST", { name: "panel.example.com", prepareOnly: true });
  const response = await handle(req, "/api/panel-host");
  expect(response.status).toBe(400);
  expect(change).toHaveBeenCalledWith("set-panel-host", { name: "panel.example.com", prepareOnly: true });
});
