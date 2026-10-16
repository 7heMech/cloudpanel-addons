import { STATE_DIR } from "../cli/paths";
import { withFileLock } from "../cli/action-common";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readRootJson, writeRootJson } from "./root-json";

export const AUTO_SSL_FILE = `${STATE_DIR}/panel-tweaks/auto-ssl.json`;
export const AUTO_SSL_LOCK = "/run/lock/clp-addons/auto-ssl.lock";
export interface AutoSslRequest {
  siteId: number;
  requestedAt: number;
  attempts: number;
  state: string;
  nextAttemptAt: number;
}
export function autoSslRequests(path = AUTO_SSL_FILE, uid = 0): Record<string, AutoSslRequest> {
  const raw = readRootJson<Record<string, AutoSslRequest>>(path, () => ({}), uid);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.values(raw).some((v) => !v || !Number.isSafeInteger(v.siteId) || !Number.isSafeInteger(v.requestedAt) || !Number.isSafeInteger(v.attempts) || v.attempts < 0 || typeof v.state !== "string" || !Number.isFinite(v.nextAttemptAt))) throw new Error("Auto SSL request state is malformed");
  return raw;
}
export async function updateAutoSsl<T>(body: (requests: Record<string, AutoSslRequest>) => T | Promise<T>, path = AUTO_SSL_FILE, lock = AUTO_SSL_LOCK, uid = 0): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  return withFileLock(lock, 15, "certificate provisioning is busy", async () => {
    const requests = autoSslRequests(path, uid);
    const result = await body(requests);
    writeRootJson(path, requests, uid);
    return result;
  });
}
