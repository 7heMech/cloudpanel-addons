import { openSync, closeSync, lstatSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { execFileSync } from "node:child_process";

export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const WILDCARD_HOSTNAME_RE = /^\*\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const DEFAULT_LOCK_DIR = process.env.LOCK_DIR || "/run/lock/clp-addons";
export const DEFAULT_PANEL_IDENTITY_FILE = process.env.PANEL_IDENTITY_FILE || "/etc/clp-addons/panel-identity.conf";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

let libcFlock: ((fd: number, operation: number) => number) | null = null;
try {
  const libc = dlopen("libc.so.6", {
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  libcFlock = libc.symbols.flock;
} catch {
  libcFlock = null;
}

export interface ActionContext {
  addon: string;
  log(msg: string): void;
  warn(msg: string): void;
  emitOk(data?: unknown): void;
  emitErr(msg: string, data?: unknown): never;
}

export function createActionContext(addon: string): ActionContext {
  return {
    addon,
    log(msg: string): void {
      process.stderr.write(`[${addon}] ${msg}\n`);
    },
    warn(msg: string): void {
      process.stderr.write(`[${addon}] WARN: ${msg}\n`);
    },
    emitOk(data?: unknown): void {
      const payload = { ok: true, data: data ?? null };
      process.stdout.write(JSON.stringify(payload) + "\n");
    },
    emitErr(msg: string, data?: unknown): never {
      process.stderr.write(`[${addon}] ERROR: ${msg}\n`);
      const payload = { ok: false, error: msg, ...(data ? { data } : {}) };
      process.stdout.write(JSON.stringify(payload) + "\n");
      process.exit(1);
    },
  };
}

export interface PanelIdentity {
  primary: string;
  aliases: string[];
}

export function normalizeDomain(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const d = candidate.trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253) return null;
  if (!HOSTNAME_RE.test(d)) return null;
  return d;
}

export function normalizeIdentityHostname(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const d = candidate.trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253) return null;
  if (WILDCARD_HOSTNAME_RE.test(d) || HOSTNAME_RE.test(d)) return d;
  return null;
}

export function readPanelIdentity(
  filePath = DEFAULT_PANEL_IDENTITY_FILE,
): PanelIdentity | null {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;

    if (process.getuid && process.getuid() === 0) {
      if (stat.uid !== 0 && !process.env.FAKEROOTKEY) return null;
      const mode = stat.mode & 0o777;
      if ((mode & 0o022) !== 0) return null;
    }

    const content = readFileSync(filePath, "utf8");
    let primary: string | null = null;
    let aliases: string[] = [];
    let seenPrimary = false;
    let seenAliases = false;

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      if (line.startsWith("PRIMARY=")) {
        if (seenPrimary) return null;
        seenPrimary = true;
        const val = line.slice("PRIMARY=".length).trim();
        const norm = normalizeDomain(val);
        if (!norm) return null;
        primary = norm;
      } else if (line.startsWith("ALIASES=")) {
        if (seenAliases) return null;
        seenAliases = true;
        const val = line.slice("ALIASES=".length).trim();
        if (val) {
          const parts = val.split(/\s+/);
          for (const p of parts) {
            const norm = normalizeIdentityHostname(p);
            if (!norm) return null;
            aliases.push(norm);
          }
        }
      } else {
        return null;
      }
    }

    if (!primary || !seenAliases) return null;
    return { primary, aliases };
  } catch {
    return null;
  }
}

export function panelIdentityMatches(
  domain: string,
  identity: PanelIdentity,
): boolean {
  if (domain === identity.primary) return true;
  for (const alias of identity.aliases) {
    if (alias.startsWith("*.")) {
      const suffix = alias.slice(2);
      if (domain === suffix || domain.endsWith("." + suffix)) return true;
    } else if (domain === alias) {
      return true;
    }
  }
  return false;
}

export function panelIdentityGuard(
  domain: string,
  ctx: ActionContext,
  identityPath?: string,
): void {
  const identity = readPanelIdentity(identityPath);
  if (!identity) {
    ctx.emitErr("the CloudPanel panel identity is missing or malformed");
  }
  const normalized = normalizeIdentityHostname(domain);
  if (!normalized) return;
  if (panelIdentityMatches(normalized, identity)) {
    ctx.emitErr(`refusing to act on the CloudPanel panel site or alias: '${domain}'`);
  }
}

export function validateDomain(
  d: string | undefined,
  ctx: ActionContext,
  options?: { paramName?: string; identityPath?: string },
): string {
  const rawParam = options?.paramName ?? "--domain";
  const flag = rawParam.startsWith("--") ? rawParam : `--${rawParam}`;
  if (!d) {
    ctx.emitErr(`missing ${flag}`);
  }
  if (d.length > 253) {
    if (options?.paramName) {
      ctx.emitErr(`the ${flag} domain is too long`);
    } else {
      ctx.emitErr("domain too long");
    }
  }
  const normalized = normalizeDomain(d);
  if (!normalized) {
    if (options?.paramName) {
      ctx.emitErr(`invalid domain for ${flag}: '${d}'`);
    } else {
      ctx.emitErr(`invalid domain: '${d}'`);
    }
  }
  panelIdentityGuard(normalized, ctx, options?.identityPath);
  return normalized;
}

export function validatePort(
  p: string | undefined,
  ctx: ActionContext,
  min = 39000,
  max = 39999,
): number {
  if (!p) {
    ctx.emitErr("missing --port");
  }
  if (!/^[0-9]{1,5}$/.test(p)) {
    ctx.emitErr(`port must be an integer: '${p}'`);
  }
  const num = parseInt(p, 10);
  if (num < min || num > max) {
    ctx.emitErr(`port ${p} outside reserved range ${min}-${max}`);
  }
  return num;
}

export function validateTag(t: string | undefined, ctx: ActionContext): string {
  if (!t) {
    ctx.emitErr("missing --tag");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(t)) {
    ctx.emitErr(`tag must be an exact version like 0.0.18, got: '${t}'`);
  }
  return t;
}

export function validateFlag(v: string | undefined, what: string, ctx: ActionContext): string {
  if (v !== "yes" && v !== "no") {
    ctx.emitErr(`--${what} takes yes or no, got: '${v}'`);
  }
  return v;
}

export function validateJobId(j: string | undefined, ctx: ActionContext): string {
  if (!j) {
    ctx.emitErr("missing --job");
  }
  if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/.test(j)) {
    ctx.emitErr(`invalid job id: '${j}'`);
  }
  return j;
}

export function validateEmail(e: string | undefined, ctx: ActionContext): string {
  if (!e) {
    ctx.emitErr("missing --email");
  }
  if (e.length > 254) {
    ctx.emitErr("--email is too long");
  }
  const emailRe = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
  if (!emailRe.test(e)) {
    ctx.emitErr(`invalid email address: '${e}'`);
  }
  return e;
}

export function validateMfa(c: string, ctx: ActionContext): string {
  if (!/^[A-Za-z0-9-]{6,32}$/.test(c)) {
    ctx.emitErr("the authentication code has an unexpected shape");
  }
  return c;
}

export interface LockHandle {
  release(): void;
}

export async function acquireDomainLock(
  domain: string,
  ctx: ActionContext,
  options?: {
    lockDir?: string;
    timeoutMs?: number;
    prefix?: string;
  },
): Promise<LockHandle> {
  const lockDir = options?.lockDir ?? DEFAULT_LOCK_DIR;
  const timeoutMs = options?.timeoutMs ?? 300_000;
  const prefix = options?.prefix ?? "";

  try {
    mkdirSync(lockDir, { recursive: true });
    try {
      chmodSync(lockDir, 0o700);
    } catch {}
  } catch {}

  const lockPath = `${lockDir}/${prefix}${domain}.lock`;
  const fd = openSync(lockPath, "w");

  let acquired = false;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (libcFlock) {
      const ret = libcFlock(fd, LOCK_EX | LOCK_NB);
      if (ret === 0) {
        acquired = true;
        break;
      }
    } else {
      try {
        execFileSync("flock", ["-x", "-n", fd.toString()], { stdio: "ignore" });
        acquired = true;
        break;
      } catch {}
    }
    await Bun.sleep(100);
  }

  if (!acquired) {
    closeSync(fd);
    ctx.emitErr(`another operation is already running for ${domain}`);
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (libcFlock) {
        try {
          libcFlock(fd, LOCK_UN);
        } catch {}
      }
      try {
        closeSync(fd);
      } catch {}
    },
  };
}

export async function withDomainLock<T>(
  domain: string,
  ctx: ActionContext,
  fn: () => Promise<T> | T,
  lockDir = DEFAULT_LOCK_DIR,
  timeoutMs = 300_000,
  prefix = "",
): Promise<T> {
  const lock = await acquireDomainLock(domain, ctx, { lockDir, timeoutMs, prefix });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
