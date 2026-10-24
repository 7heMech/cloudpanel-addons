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

test("provision requires a session and the mutation guard before requesting root work", async () => {
  const provision = spyOn(dnsService, "provision");
  const req = () => appRequest("/api/provision", "POST", { domain: "example.com" });
  expect((await handle(req(), "/api/provision")).status).toBe(404);
  const unguarded = appRequest("/api/provision", "POST", { domain: "example.com" }, false);
  expect((await handle(unguarded, "/api/provision", undefined, undefined, { user: "bob", roles: ["ROLE_USER"] })).status).toBe(403);
  expect(provision).not.toHaveBeenCalled();
});
