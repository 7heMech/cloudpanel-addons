import { expect, mock, test } from "bun:test";

// Keep the real session reply validation and role policy; only the transport
// to the root helper is substituted.
let reply: Record<string, unknown> | null;
const gateway = await import("../lib/gateway-client");
mock.module("../lib/gateway-client", () => ({
  ...gateway,
  callGatewayAuth: async () => reply === null ? null : JSON.stringify(reply),
}));
const { stillAuthorized } = await import("../lib/sso-auth");
const { jobEventStream } = await import("../lib/job-stream");

const req = new Request("https://panel.example/addons/instatic/api/jobs/x/events", {
  headers: { Cookie: "cloudpanel=live" },
});
function role(value: string) {
  reply = { valid: true, user: "operator", roles: [value], expiresAt: Math.floor(Date.now() / 1000) + 60 };
}
const snapshot = { job: { state: "running", step: "Creating site" }, log: "working" };
function text(value: unknown): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value as Uint8Array);
}

test("stream role opt-in admits site managers while keeping the default administrator-only", async () => {
  for (const [value, adminOnly, siteManager] of [
    ["ROLE_ADMIN", true, true],
    ["ROLE_SITE_MANAGER", false, true],
    ["ROLE_USER", false, false],
  ] as const) {
    role(value);
    expect(await stillAuthorized(req)).toBe(adminOnly);
    expect(await stillAuthorized(req, { siteManager: true })).toBe(siteManager);
  }
  reply = { valid: false };
  expect(await stillAuthorized(req, { siteManager: true })).toBe(false);
  reply = { valid: true, user: "operator", roles: ["ROLE_SITE_MANAGER"], expiresAt: 1 };
  expect(await stillAuthorized(req, { siteManager: true })).toBe(false);
  reply = null;
  expect(await stillAuthorized(req, { siteManager: true })).toBe("unavailable");
});

test("an opted-in site manager keeps progress until demotion revokes the stream", async () => {
  role("ROLE_SITE_MANAGER");
  let closed = false;
  let emit: (next: typeof snapshot) => void = () => {};
  const res = await jobEventStream({
    req, id: "20260910T093000Z-a1b2c3", siteManager: true, recheckMs: 10,
    getJob: async () => ({ ok: true, data: snapshot }),
    watchJob: (_id, handlers) => {
      emit = handlers.onSnapshot;
      return { close() { closed = true; } };
    },
  });
  const reader = res.body!.getReader();
  try {
    expect(text((await reader.read()).value)).toContain("Creating site");
    await Bun.sleep(35);
    expect(closed).toBe(false);
    emit({ job: { state: "running", step: "Starting container" }, log: "more" });
    expect(text((await reader.read()).value)).toContain("Starting container");
    role("ROLE_USER");
    expect(text((await reader.read()).value)).toStartWith("event: unauthorized");
    expect((await reader.read()).done).toBe(true);
    expect(closed).toBe(true);
  } finally {
    await reader.cancel();
  }
});

test("a default stream closes when an administrator becomes a site manager", async () => {
  role("ROLE_ADMIN");
  const res = await jobEventStream({
    req, id: "20260910T093000Z-a1b2c3", recheckMs: 10,
    getJob: async () => ({ ok: true, data: snapshot }),
    watchJob: () => ({ close() {} }),
  });
  const reader = res.body!.getReader();
  try {
    await reader.read();
    role("ROLE_SITE_MANAGER");
    expect(text((await reader.read()).value)).toStartWith("event: unauthorized");
    expect((await reader.read()).done).toBe(true);
  } finally {
    await reader.cancel();
  }
});
