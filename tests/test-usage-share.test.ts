import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatUsageSharingStatus,
  isoWeek,
  payloadHash,
  readUsageSharing,
  saveUsageSharing,
  shareUsageIfDue,
  USAGE_URL,
  usagePayload,
  usageSharingStatus,
  type UsagePayload,
} from "../lib/usage-share";
import { csrfCookieHeader, newCsrfToken } from "../lib/app-http";
import { handleManagerRoute } from "../manager/index";

const uid = process.getuid!();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clp-usage-share-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("usage payload", () => {
  test("contains only the four documented fields, normalized and sorted", () => {
    const payload = usagePayload(["wp-tools", "dns", "firewall"], "v2.1.0", "2.5.4-3+clp-bookworm", "x64");
    expect(Object.keys(payload).sort()).toEqual(["addons", "arch", "cloudpanel", "version"]);
    expect(payload).toEqual({
      version: "2.1.0",
      cloudpanel: "2.5.4",
      arch: "x64",
      addons: ["dns", "firewall", "wp-tools"],
    });
  });

  test("records null cloudpanel when dpkg cannot report a version", () => {
    expect(usagePayload([], "2.1.0", null, "arm64")).toEqual({
      version: "2.1.0",
      cloudpanel: null,
      arch: "arm64",
      addons: [],
    });
  });
});

describe("ISO week calculation", () => {
  test("handles mid-year dates and ISO year boundaries", () => {
    expect(isoWeek(new Date("2026-11-26T10:00:00Z"))).toBe("2026-W48");
    expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    expect(isoWeek(new Date("2025-12-29T00:00:00Z"))).toBe("2026-W01");
    expect(isoWeek(new Date("2021-01-01T00:00:00Z"))).toBe("2020-W53");
  });
});

describe("state persistence", () => {
  test("defaults to unanswered and disabled when no file exists", () => {
    const file = join(dir, "usage-sharing.json");
    expect(readUsageSharing(file, uid)).toEqual({
      answered: false,
      enabled: false,
      lastSentAt: null,
      lastSentWeek: null,
      lastSentHash: null,
    });
  });

  test("saves a 0600 file and keeps prior send markers across toggles", () => {
    const file = join(dir, "usage-sharing.json");
    saveUsageSharing(true, file, uid);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readUsageSharing(file, uid)).toEqual({
      answered: true,
      enabled: true,
      lastSentAt: null,
      lastSentWeek: null,
      lastSentHash: null,
    });

    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    raw.lastSentAt = "2026-11-26T10:00:00.000Z";
    raw.lastSentWeek = "2026-W48";
    raw.lastSentHash = "abc";
    writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });

    saveUsageSharing(false, file, uid);
    expect(readUsageSharing(file, uid)).toEqual({
      answered: true,
      enabled: false,
      lastSentAt: "2026-11-26T10:00:00.000Z",
      lastSentWeek: "2026-W48",
      lastSentHash: "abc",
    });
  });

  test("refuses loose permissions and symlinks", () => {
    const file = join(dir, "usage-sharing.json");
    saveUsageSharing(true, file, uid);
    chmodSync(file, 0o644);
    expect(() => readUsageSharing(file, uid)).toThrow("refusing untrusted state");

    const link = join(dir, "link.json");
    symlinkSync(file, link);
    expect(() => readUsageSharing(link, uid)).toThrow("refusing untrusted state");
  });
});

describe("shareUsageIfDue", () => {
  const basePayload: UsagePayload = {
    version: "2.1.0",
    cloudpanel: "2.5.4",
    arch: "x64",
    addons: ["dns", "system-tweaks"],
  };

  test("never sends while unanswered or disabled", async () => {
    const file = join(dir, "usage-sharing.json");
    let called = 0;
    const mockFetch = (async () => {
      called++;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    expect(await shareUsageIfDue(() => basePayload, { file, uid, fetch: mockFetch })).toBe(false);
    expect(called).toBe(0);

    saveUsageSharing(false, file, uid);
    expect(await shareUsageIfDue(() => basePayload, { file, uid, fetch: mockFetch })).toBe(false);
    expect(called).toBe(0);
  });

  test("posts the exact four-field payload, deduplicates within an ISO week, and resends on payload or week change", async () => {
    const file = join(dir, "usage-sharing.json");
    saveUsageSharing(true, file, uid);

    const requests: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
    const mockFetch = (async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const week48 = new Date("2026-11-26T10:00:00Z");
    expect(await shareUsageIfDue(() => basePayload, { file, uid, now: week48, fetch: mockFetch })).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(USAGE_URL);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers).toEqual({
      "Content-Type": "application/json",
      "User-Agent": "clp-addons/2.1.0",
    });
    expect(JSON.parse(requests[0]!.body)).toEqual(basePayload);

    const saved = readUsageSharing(file, uid);
    expect(saved.lastSentAt).toBe(week48.toISOString());
    expect(saved.lastSentWeek).toBe("2026-W48");
    expect(saved.lastSentHash).toBe(payloadHash(basePayload));
    expect(requests[0]!.body).not.toContain(saved.lastSentHash!);

    // Same week and same payload: skipped.
    expect(await shareUsageIfDue(() => basePayload, { file, uid, now: new Date("2026-11-27T12:00:00Z"), fetch: mockFetch })).toBe(false);
    expect(requests).toHaveLength(1);

    // Same week but enabled addons changed: sent again.
    const changedPayload: UsagePayload = { ...basePayload, addons: ["dns", "firewall", "system-tweaks"] };
    expect(await shareUsageIfDue(() => changedPayload, { file, uid, now: new Date("2026-11-27T13:00:00Z"), fetch: mockFetch })).toBe(true);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1]!.body)).toEqual(changedPayload);

    // Next ISO week with unchanged payload: sent again.
    const week49 = new Date("2026-12-01T08:00:00Z");
    expect(await shareUsageIfDue(() => changedPayload, { file, uid, now: week49, fetch: mockFetch })).toBe(true);
    expect(requests).toHaveLength(3);
    expect(readUsageSharing(file, uid).lastSentWeek).toBe("2026-W49");
  });

  test("silently ignores fetch errors and non-2xx responses without updating state", async () => {
    const file = join(dir, "usage-sharing.json");
    saveUsageSharing(true, file, uid);

    const failingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await shareUsageIfDue(() => basePayload, { file, uid, fetch: failingFetch })).toBe(false);
    expect(readUsageSharing(file, uid).lastSentAt).toBeNull();

    const errorStatusFetch = (async () => new Response("error", { status: 503 })) as unknown as typeof fetch;
    expect(await shareUsageIfDue(() => basePayload, { file, uid, fetch: errorStatusFetch })).toBe(false);
    expect(readUsageSharing(file, uid).lastSentAt).toBeNull();
  });

  test("does not re-enable sharing if root turned it off while a send was in flight", async () => {
    const file = join(dir, "usage-sharing.json");
    const lockFile = join(dir, "usage-sharing.lock");
    saveUsageSharing(true, file, uid, lockFile);

    const mockFetch = (async () => {
      // Network request runs outside the lock, so a concurrent consent save does not block on fetch.
      saveUsageSharing(false, file, uid, lockFile);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    expect(await shareUsageIfDue(() => basePayload, { file, lockFile, uid, fetch: mockFetch })).toBe(true);
    expect(readUsageSharing(file, uid).enabled).toBe(false);
    expect(readUsageSharing(file, uid).lastSentAt).toBeNull();
  });

  test("serializes completion writes with a concurrent consent change holding the lock", async () => {
    const { acquireFileLockSync } = await import("../lib/file-lock");
    const file = join(dir, "usage-sharing-locked.json");
    const lockFile = join(dir, "usage-sharing-locked.lock");
    saveUsageSharing(true, file, uid, lockFile);

    let hold: ReturnType<typeof acquireFileLockSync> | null = null;
    const mockFetch = (async () => {
      // Hold the lock as another process would while it updates consent to false.
      hold = acquireFileLockSync(lockFile, 5, "busy");
      setTimeout(() => {
        writeFileSync(file, JSON.stringify({ answered: true, enabled: false, lastSentAt: null, lastSentWeek: null, lastSentHash: null }), { mode: 0o600 });
        hold?.release();
      }, 40);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    expect(await shareUsageIfDue(() => basePayload, { file, lockFile, uid, fetch: mockFetch })).toBe(true);
    expect(readUsageSharing(file, uid).enabled).toBe(false);
    expect(readUsageSharing(file, uid).lastSentAt).toBeNull();
  });
});

describe("status formatting and manager route validation", () => {
  const payload: UsagePayload = { version: "2.1.0", cloudpanel: "2.5.4", arch: "x64", addons: ["dns"] };

  test("prints state and exact JSON payload", () => {
    const file = join(dir, "usage-sharing.json");
    const unanswered = formatUsageSharingStatus(payload, file, uid);
    expect(unanswered).toContain("Usage sharing: off (not answered yet)");
    expect(unanswered).toContain(JSON.stringify(payload, null, 2));

    saveUsageSharing(true, file, uid);
    expect(usageSharingStatus(payload, file, uid)).toEqual({
      answered: true,
      enabled: true,
      lastSentAt: null,
      payload,
    });
    expect(formatUsageSharingStatus(payload, file, uid)).toContain("Usage sharing: on");

    saveUsageSharing(false, file, uid);
    expect(formatUsageSharingStatus(payload, file, uid)).toContain("Usage sharing: off\nPayload:");
  });

  test("POST /addons/api/usage-sharing enforces CSRF and validates boolean enabled", async () => {
    const noCsrf = await handleManagerRoute(
      new Request("http://localhost/api/usage-sharing", {
        method: "POST",
        headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "/api/usage-sharing",
      {} as never,
    );
    expect(noCsrf?.status).toBe(403);

    const token = newCsrfToken();
    const badBody = await handleManagerRoute(
      new Request("http://localhost/api/usage-sharing", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost",
          cookie: csrfCookieHeader(token),
          "x-clp-addons-csrf": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: "yes" }),
      }),
      "/api/usage-sharing",
      {} as never,
    );
    expect(badBody?.status).toBe(400);
    expect(await badBody!.json()).toEqual({ ok: false, error: "expected enabled" });
  });
});
