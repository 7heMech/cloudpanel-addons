import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countAction,
  FORGET_URL,
  formatUsageSharingStatus,
  ID_PLACEHOLDER,
  MAX_ACTION_COUNT,
  readActivity,
  readUsageSharing,
  saveUsageSharing,
  sendForget,
  settleActivity,
  usageReport,
  usageSharingStatus,
} from "../lib/usage-share";
import { countedActions } from "../lib/usage-actions";
import { ADDON_NAMES } from "../addons/catalog";
import { csrfCookieHeader, newCsrfToken } from "../lib/app-http";
import { handleManagerRoute } from "../manager/index";

const uid = process.getuid!();
let dir: string;
let paths: { file: string; uid: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clp-usage-share-"));
  paths = { file: join(dir, "usage-sharing.json"), uid };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("counted actions", () => {
  test("are web verbs of catalog addons, without streams, job polling or the manager", () => {
    const actions = countedActions();
    expect(Object.keys(actions).every((addon) => ADDON_NAMES.includes(addon))).toBe(true);
    expect(actions.manager).toBeUndefined();
    expect(actions.dns).toContain("save-profile");
    expect(actions.git).toContain("deploy");
    expect(actions.git).not.toContain("job");
    expect(actions.git).not.toContain("watch-job");
    expect(actions.git).not.toContain("run");
  });
});

describe("opting in and out", () => {
  test("starts unanswered; yes makes a random ID in a 0600 file; no drops it and queues its deletion", () => {
    expect(readUsageSharing(paths)).toEqual({ answered: false, enabled: false, id: null, forget: null, lastSentAt: null });
    const on = saveUsageSharing(true, paths);
    expect(on.id).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(paths.file).mode & 0o777).toBe(0o600);
    expect(saveUsageSharing(true, paths).id).toBe(on.id);

    const off = saveUsageSharing(false, paths);
    expect(off).toEqual({ answered: true, enabled: false, id: null, forget: on.id, lastSentAt: null });
    const again = saveUsageSharing(true, paths);
    expect(again.id).not.toBe(on.id);
    expect(again.forget).toBe(on.id);
  });

  test("refuses loose permissions and symlinks", () => {
    saveUsageSharing(true, paths);
    chmodSync(paths.file, 0o644);
    expect(() => readUsageSharing(paths)).toThrow("refusing untrusted state");
    chmodSync(paths.file, 0o600);
    const link = join(dir, "link.json");
    symlinkSync(paths.file, link);
    expect(() => readUsageSharing({ file: link, uid })).toThrow("refusing untrusted state");
  });

  test("the deletion is sent by ID and cleared only once the Worker confirms it", async () => {
    const id = saveUsageSharing(true, paths).id;
    saveUsageSharing(false, paths);
    const calls: { url: string; body: unknown }[] = [];
    let status = 502;
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    expect(await sendForget({ ...paths, fetch: fetcher })).toBe(false);
    expect(readUsageSharing(paths).forget).toBe(id);
    status = 200;
    expect(await sendForget({ ...paths, fetch: fetcher })).toBe(true);
    expect(calls).toEqual([{ url: FORGET_URL, body: { id } }, { url: FORGET_URL, body: { id } }]);
    expect(readUsageSharing(paths).forget).toBeNull();
    expect(await sendForget({ ...paths, fetch: fetcher })).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("activity counts", () => {
  test("count only allowlisted actions, only while sharing is on, clamped", async () => {
    await countAction("dns", "list", paths);
    expect(existsSync(`${paths.file}.activity`)).toBe(false);

    saveUsageSharing(true, paths);
    await countAction("dns", "list", paths);
    await countAction("dns", "list", paths);
    await countAction("git", "job", paths);
    await countAction("dns", "example.com", paths);
    await countAction("manager", "enable", paths);
    await countAction("constructor", "list", paths);
    expect(readActivity(paths)).toEqual({ dns: { list: 2 } });
    expect(statSync(`${paths.file}.activity`).mode & 0o777).toBe(0o600);

    for (let i = 0; i < 3; i++) await countAction("firewall", "set", paths);
    expect(readActivity(paths).firewall).toEqual({ set: 3 });
    expect(MAX_ACTION_COUNT).toBe(10_000);
  });

  test("a send takes off what it carried and keeps what ran meanwhile; opting out deletes them", async () => {
    saveUsageSharing(true, paths);
    for (let i = 0; i < 3; i++) await countAction("dns", "list", paths);
    const report = usageReport(["firewall", "dns"], paths, "2.5.4-3+clp-bookworm")!;
    expect(report).toEqual({ id: readUsageSharing(paths).id!, cloudpanel: "2.5.4", addons: ["dns", "firewall"], activity: { dns: { list: 3 } } });
    await countAction("dns", "list", paths);
    await countAction("smtp", "test", paths);
    settleActivity(report.activity, new Date("2026-11-28T00:05:00Z"), paths);
    expect(readActivity(paths)).toEqual({ dns: { list: 1 }, smtp: { test: 1 } });
    expect(readUsageSharing(paths).lastSentAt).toBe("2026-11-28T00:05:00.000Z");

    saveUsageSharing(false, paths);
    expect(existsSync(`${paths.file}.activity`)).toBe(false);
    expect(usageReport(["dns"], paths)).toBeNull();
  });
});

describe("status and manager route", () => {
  test("shows the daily check's body, with a placeholder ID until sharing is on", () => {
    const off = usageSharingStatus(["dns"], paths, "2.5.4", "2.2.0", "x64");
    expect(off.payload).toEqual({
      version: "2.2.0", channel: "stable", arch: "x64",
      usage: { id: ID_PLACEHOLDER, cloudpanel: "2.5.4", addons: ["dns"], activity: {} },
    });
    expect(formatUsageSharingStatus(["dns"], paths)).toContain("Usage sharing: off (not answered yet)");

    const { id } = saveUsageSharing(true, paths);
    const on = usageSharingStatus(["dns"], paths, null, "2.2.0-rc.3", "arm64");
    expect(on).toMatchObject({ answered: true, enabled: true, payload: { version: "2.2.0-rc.3", channel: "prerelease", arch: "arm64", usage: { id, cloudpanel: null } } });
    const text = formatUsageSharingStatus(["dns"], paths);
    expect(text).toContain("Usage sharing: on");
    expect(text).toContain(id!);
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

    const oversized = await handleManagerRoute(
      new Request("http://localhost/api/usage-sharing", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost",
          cookie: csrfCookieHeader(token),
          "x-clp-addons-csrf": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true, pad: "x".repeat(2048) }),
      }),
      "/api/usage-sharing",
      {} as never,
    );
    expect(oversized?.status).toBe(413);
  });
});
