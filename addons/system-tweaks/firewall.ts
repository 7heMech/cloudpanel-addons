/**
 * A protocol for each rule on CloudPanel's own Firewall page. CloudPanel opens
 * every rule for TCP and rebuilds ufw from its table with `ufw reset` on every
 * change there, so this keeps the protocols itself and puts them back into ufw
 * whenever ufw's rule files change. See "Firewall" in docs/decisions/system-tweaks.md.
 */
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { failAction, runCommand, withFileLockSync, type CommandResult } from "../../cli/action-common";
import { withPanelDb } from "../../cli/panel-db";
import { LOCK_DIR, PANEL_DB, ROOT_UID, STATE_DIR, UFW_RULE_FILES } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";

export type FirewallProtocol = "tcp" | "udp" | "both";
export const FIREWALL_PROTOCOLS: readonly FirewallProtocol[] = ["tcp", "udp", "both"];

const STATE_VERSION = 2;
/** How long a protocol no rule has matched yet waits for one before it is forgotten. */
export const UNMATCHED_GRACE_MS = 60 * 60_000;
/** CloudPanel's own port: UDP alone there would close the panel to TCP. */
const PANEL_PORT = "8443";
/** ufw's files must have been left alone this long before they are read. */
const QUIET_MS = 2_000;
const QUIET_LIMIT_MS = 60_000;
const MAX_PASSES = 5;

export interface PanelRule { id: number; portRange: string; source: string }
export interface UfwRule { proto: "tcp" | "udp"; port: string; src: string }

export interface FirewallState {
  /** By `<port range> <source>` (see ruleKey); a rule with no entry is CloudPanel's own TCP. */
  protocols: Record<string, Exclude<FirewallProtocol, "tcp">>;
  /** Entries no rule has matched yet, with when they were chosen. */
  unmatched: Record<string, number>;
  /** The ufw rules this addon added or removed against CloudPanel's own, so it can put them back. */
  managed: UfwRule[];
  /** Set while System Tweaks is off, so a watcher still running then applies nothing. */
  withdrawn?: boolean;
}

export interface FirewallPaths {
  stateFile: string;
  lockFile: string;
  panelDb: string;
  userRules: string;
  user6Rules: string;
  rootUid: number;
}

export const DEFAULT_FIREWALL_PATHS: FirewallPaths = {
  stateFile: `${STATE_DIR}/system-tweaks/firewall.json`,
  lockFile: `${LOCK_DIR}/system-tweaks-firewall.lock`,
  panelDb: PANEL_DB,
  userRules: UFW_RULE_FILES[0]!,
  user6Rules: UFW_RULE_FILES[1]!,
  rootUid: ROOT_UID,
};

export interface FirewallOptions {
  paths?: Partial<FirewallPaths>;
  ufw?: (args: string[]) => CommandResult;
  now?: () => number;
  sleep?: (ms: number) => void;
}

function pathsOf(options: FirewallOptions): FirewallPaths {
  return { ...DEFAULT_FIREWALL_PATHS, ...options.paths };
}

// --- Addresses, as ufw writes them in its tuples ---------------------------

function ipv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return parts.map(Number);
}

function ipv6(text: string): number[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(text) || (text.match(/::/g) ?? []).length > 1) return null;
  const [head = "", tail] = text.split("::");
  const groups = (part: string) => part === "" ? [] : part.split(":");
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  if (![...left, ...right].every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  return [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right].map((group) => parseInt(group, 16));
}

function ipv6Text(groups: number[]): string {
  // RFC 5952, as inet_ntop writes it: the longest run of two or more zero groups becomes `::`.
  let best = -1, bestLength = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) { best = i; bestLength = j - i; }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLength).join(":")}`;
}

function mask(values: number[], width: number, prefix: number): number[] {
  return values.map((value, index) => {
    const kept = Math.min(width, Math.max(0, prefix - index * width));
    return kept === 0 ? 0 : value & ~((1 << (width - kept)) - 1) & ((1 << width) - 1);
  });
}

/** A rule's source the way ufw records it, or null for anything else. */
export function normalizeSource(raw: string): { text: string; v6: boolean } | null {
  const [address = "", prefixText, extra] = raw.trim().split("/");
  if (extra !== undefined || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) return null;
  const v4 = ipv4(address);
  const v6 = v4 ? null : ipv6(address);
  if (!v4 && !v6) return null;
  const bits = v4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (prefix > bits) return null;
  const network = v4 ? mask(v4, 8, prefix).join(".") : ipv6Text(mask(v6!, 16, prefix));
  return { text: prefix === bits ? network : `${network}/${prefix}`, v6: Boolean(v6) };
}

/** A Port Range as CloudPanel's form stores it: each side trimmed and read as a number. */
export function normalizePortRange(text: string): string | null {
  const parts = text.split("-").map((part) => part.trim());
  if (parts.length > 2 || !parts.every((part) => /^\d{1,5}$/.test(part))) return null;
  const range = parts.map(Number).join("-");
  return ufwPort(range) ? range : null;
}

/** CloudPanel's `22` or `8000-8100`, as ufw's `22` or `8000:8100`; null for anything else. */
export function ufwPort(portRange: string): string | null {
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(portRange);
  if (!match) return null;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to > 65535 || from > to) return null;
  return match[2] === undefined || from === to ? String(from) : `${from}:${to}`;
}

/** What a rule is, as CloudPanel's form stores the range and ufw writes the source: `51820 0.0.0.0/0`. */
export function ruleKey(portRange: string, source: string): string | null {
  const range = normalizePortRange(portRange);
  const address = normalizeSource(source);
  return range && address ? `${range} ${address.text}` : null;
}

// --- What is on disk -------------------------------------------------------

export function readPanelRules(panelDb: string): PanelRule[] {
  if (!existsSync(panelDb)) return [];
  return withPanelDb(panelDb, (db) => db.query("SELECT id, port_range, source FROM firewall_rule ORDER BY id").all()
    .map((row) => {
      const { id, port_range, source } = row as { id: number; port_range: unknown; source: unknown };
      return { id: Number(id), portRange: String(port_range ?? ""), source: String(source ?? "") };
    }));
}

/** The plain `allow ... in` rules in ufw's own files, by protocol, port and source. */
export function parseUfwRules(text: string): UfwRule[] {
  const rules: UfwRule[] = [];
  for (const line of text.split("\n")) {
    const match = /^### tuple ### (.*)$/.exec(line.trim());
    if (!match) continue;
    const [action, proto, port, dst, sport, src, direction] = match[1]!.split(" ");
    if (action !== "allow" || (proto !== "tcp" && proto !== "udp") || direction !== "in" || sport !== "any") continue;
    if (dst !== "0.0.0.0/0" && dst !== "::/0") continue;
    if (!port || !src) continue;
    rules.push({ proto, port, src });
  }
  return rules;
}

function readUfwRules(paths: FirewallPaths): UfwRule[] {
  return [paths.userRules, paths.user6Rules].flatMap((path) => existsSync(path) ? parseUfwRules(readFileSync(path, "utf8")) : []);
}

export function readFirewallState(paths: FirewallPaths): FirewallState {
  const state: FirewallState = { protocols: {}, unmatched: {}, managed: [] };
  if (!existsSync(paths.stateFile)) return state;
  const info = lstatSync(paths.stateFile);
  if (!info.isFile() || info.uid !== paths.rootUid || (info.mode & 0o022) !== 0) {
    failAction("the firewall protocols file is not a trusted regular file");
  }
  let stored: Record<string, unknown>;
  try { stored = JSON.parse(readFileSync(paths.stateFile, "utf8")); } catch { return state; }
  if (stored?.version !== STATE_VERSION) return state;
  if (stored.withdrawn === true) state.withdrawn = true;
  const unmatched = (stored.unmatched ?? {}) as Record<string, unknown>;
  for (const [key, protocol] of Object.entries((stored.protocols ?? {}) as Record<string, unknown>)) {
    const [range = "", source = ""] = key.split(" ");
    if (ruleKey(range, source) !== key || (protocol !== "udp" && protocol !== "both")) continue;
    state.protocols[key] = protocol;
    if (typeof unmatched[key] === "number") state.unmatched[key] = unmatched[key];
  }
  if (Array.isArray(stored.managed)) {
    for (const item of stored.managed as Record<string, unknown>[]) {
      const port = typeof item?.port === "string" ? item.port : "";
      const source = typeof item?.src === "string" ? normalizeSource(item.src) : null;
      if ((item.proto === "tcp" || item.proto === "udp") && /^\d{1,5}(:\d{1,5})?$/.test(port) && source) {
        state.managed.push({ proto: item.proto, port, src: source.text });
      }
    }
  }
  return state;
}

function writeFirewallState(paths: FirewallPaths, state: FirewallState): void {
  writeFileAtomic(paths.stateFile, `${JSON.stringify({ version: STATE_VERSION, ...state }, null, 2)}\n`, { mode: 0o600, createParent: true });
}

// --- Deciding --------------------------------------------------------------

/**
 * Forgets an entry once a rule matched it and none does any more, and one no
 * rule has matched once it has waited UNMATCHED_GRACE_MS: the forms record a
 * choice before CloudPanel saves its rule.
 */
export function settleState(state: FirewallState, rules: PanelRule[], now: number): FirewallState {
  const present = new Set(rules.map((rule) => ruleKey(rule.portRange, rule.source)));
  const protocols: FirewallState["protocols"] = {};
  const unmatched: FirewallState["unmatched"] = {};
  for (const [key, protocol] of Object.entries(state.protocols)) {
    const since = state.unmatched[key];
    if (present.has(key)) protocols[key] = protocol;
    else if (since !== undefined && now - since < UNMATCHED_GRACE_MS) {
      protocols[key] = protocol;
      unmatched[key] = since;
    }
  }
  return { ...state, protocols, unmatched };
}

/** CloudPanel's own UDP rules, for HTTP/3, which it adds on every rebuild. */
const PANEL_UDP = new Set(["443 0.0.0.0/0", "443 ::/0"]);

const key = (rule: { proto: string; port: string; src: string }) => `${rule.proto} ${rule.port} ${rule.src}`;

export interface FirewallPlan {
  /** ufw arguments, run in order. */
  commands: string[][];
  /** What this addon holds against CloudPanel's own rules once they have run. */
  managed: UfwRule[];
}

/**
 * The ufw commands that make ufw match the protocols, touching only rules a
 * protocol asks for and the ones it asked for before. With no protocols,
 * which is what switching System Tweaks off passes, the rules this addon
 * changed go back to CloudPanel's own: TCP for every rule, and UDP 443.
 */
export function planFirewall(rules: PanelRule[], protocols: FirewallState["protocols"], managed: UfwRule[], present: UfwRule[]): FirewallPlan {
  // Rules for one port and source are one ufw rule each way: open if any of them asks.
  const groups = new Map<string, { port: string; src: string; tcp: boolean; udp: boolean }>();
  for (const rule of rules) {
    const port = ufwPort(rule.portRange);
    const source = normalizeSource(rule.source);
    if (!port || !source) continue;
    const name = `${port} ${source.text}`;
    const group = groups.get(name) ?? { port, src: source.text, tcp: false, udp: false };
    const protocol = protocols[ruleKey(rule.portRange, rule.source) ?? ""] ?? "tcp";
    group.tcp ||= protocol !== "udp";
    group.udp ||= protocol !== "tcp";
    groups.set(name, group);
  }
  const wanted = new Map<string, UfwRule & { on: boolean }>();
  for (const { port, src, tcp, udp } of groups.values()) {
    if (!udp) continue;
    wanted.set(key({ proto: "udp", port, src }), { proto: "udp", port, src, on: true });
    if (!tcp) wanted.set(key({ proto: "tcp", port, src }), { proto: "tcp", port, src, on: false });
  }

  const have = new Set(present.map(key));
  const commands: string[][] = [];
  const ensure = (rule: UfwRule, on: boolean) => {
    if (have.has(key(rule)) === on) return;
    const spec = ["proto", rule.proto, "from", rule.src, "to", "any", "port", rule.port];
    commands.push(on ? ["allow", ...spec] : ["delete", "allow", ...spec]);
  };
  for (const rule of wanted.values()) ensure(rule, rule.on);
  for (const rule of managed) {
    if (wanted.has(key(rule))) continue;
    // Released: back to what CloudPanel itself would have.
    const own = rule.proto === "tcp" ? groups.has(`${rule.port} ${rule.src}`) : PANEL_UDP.has(`${rule.port} ${rule.src}`);
    ensure(rule, own);
  }
  // Additions first, so a port moving from TCP to UDP is never closed to both.
  commands.sort((a, b) => Number(a[0] === "delete") - Number(b[0] === "delete"));
  return { commands, managed: [...wanted.values()].map(({ proto, port, src }) => ({ proto, port, src })) };
}

// --- Doing -----------------------------------------------------------------

function systemUfw(args: string[]): CommandResult {
  return runCommand("ufw", args, 30_000);
}

function rulesMtime(paths: FirewallPaths): string {
  return [paths.userRules, paths.user6Rules].map((path) => {
    try { return String(statSync(path).mtimeMs); } catch { return "-"; }
  }).join(" ");
}

/** Waits until ufw's files have stopped changing, which CloudPanel's rebuild does several times in a row. */
function waitForQuiet(paths: FirewallPaths, now: () => number, sleep: (ms: number) => void): void {
  const start = now();
  let seen = rulesMtime(paths);
  let since = now();
  while (now() - since < QUIET_MS && now() - start < QUIET_LIMIT_MS) {
    sleep(250);
    const current = rulesMtime(paths);
    if (current !== seen) { seen = current; since = now(); }
  }
}

function ufwInstalled(paths: FirewallPaths): boolean {
  return existsSync(paths.userRules) || existsSync(paths.user6Rules);
}

/**
 * Brings ufw in line with the stored protocols. It repeats until a pass finds
 * nothing to change, because CloudPanel may still be rebuilding when it starts.
 * `withdraw` puts back CloudPanel's own rules and marks the protocols withdrawn,
 * which every later `apply` respects until `restore` clears it.
 */
export function syncFirewall(mode: "apply" | "withdraw" | "restore", options: FirewallOptions = {}): string | null {
  const paths = pathsOf(options);
  const enabled = mode !== "withdraw";
  if (!ufwInstalled(paths)) return null;
  // Nothing chosen and nothing changed: ufw is CloudPanel's alone.
  const held = readFirewallState(paths);
  const idle = !Object.keys(held.protocols).length && !held.managed.length;
  if (idle && Boolean(held.withdrawn) === !enabled) return null;
  if (mode === "apply" && held.withdrawn) return null;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleepSync;
  const ufw = options.ufw ?? systemUfw;
  let changed = 0;
  let previous = "";
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (enabled) waitForQuiet(paths, now, sleep);
    const commands = withFileLockSync(paths.lockFile, 30, "another firewall change is still running", () => {
      const stored = readFirewallState(paths);
      if (mode === "apply" && stored.withdrawn) return [];
      const rules = readPanelRules(paths.panelDb);
      const state = settleState(stored, rules, now());
      const plan = planFirewall(rules, enabled ? state.protocols : {}, state.managed, readUfwRules(paths));
      const failures: string[] = [];
      for (const args of plan.commands) {
        const result = ufw(args);
        if (!result.ok) failures.push(`ufw ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
      }
      // A rule that failed stays managed, so the next pass tries it again.
      const managed = failures.length ? [...plan.managed, ...state.managed.filter((rule) => !plan.managed.some((kept) => key(kept) === key(rule)))] : plan.managed;
      const next: FirewallState = { ...state, managed };
      if (enabled) delete next.withdrawn;
      else next.withdrawn = true;
      if (JSON.stringify(next) !== JSON.stringify(stored)) writeFirewallState(paths, next);
      if (failures.length) throw new Error(failures.join("; "));
      return plan.commands;
    });
    if (!commands.length) break;
    changed += commands.length;
    // The same commands twice means ufw does not record them as planned; stop rather than loop.
    const signature = JSON.stringify(commands);
    if (signature === previous) throw new Error(`ufw did not take: ${commands.map((args) => args.join(" ")).join("; ")}`);
    previous = signature;
  }
  return changed ? `${changed} ufw rule${changed === 1 ? "" : "s"} changed` : null;
}

// --- What the panel's pages ask for ----------------------------------------

export interface FirewallStatus {
  /** Whether ufw is on this box at all. */
  available: boolean;
  /** By CloudPanel's rule id, for its pages: the rules that are not TCP alone. */
  protocols: Record<string, FirewallProtocol>;
  /** The port ranges open to UDP by a rule's protocol, besides CloudPanel's own 443. */
  udpPorts: string[];
}

export function firewallStatus(options: FirewallOptions = {}): FirewallStatus {
  const paths = pathsOf(options);
  if (!ufwInstalled(paths)) return { available: false, protocols: {}, udpPorts: [] };
  const state = readFirewallState(paths);
  const protocols: FirewallStatus["protocols"] = {};
  const udpPorts = new Set<string>();
  for (const rule of readPanelRules(paths.panelDb)) {
    const protocol = state.protocols[ruleKey(rule.portRange, rule.source) ?? ""];
    if (!protocol) continue;
    protocols[rule.id] = protocol;
    udpPorts.add(rule.portRange);
  }
  return { available: true, protocols, udpPorts: [...udpPorts].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)) };
}

/**
 * What the add and edit forms send just before CloudPanel's own submit: the
 * Port Range and Source they hold, the protocol, and on the edit form the
 * rule's id. CloudPanel applies it when it rebuilds ufw after saving.
 */
export function setRuleProtocol(body: Record<string, unknown>, options: FirewallOptions = {}): void {
  const paths = pathsOf(options);
  if (!FIREWALL_PROTOCOLS.includes(body.protocol as FirewallProtocol)) failAction("protocol must be tcp, udp or both");
  const protocol = body.protocol as FirewallProtocol;
  const key = typeof body.portRange === "string" && typeof body.source === "string" ? ruleKey(body.portRange, body.source) : null;
  if (!key) failAction("Port Range must be a port or a range such as 8000-8100, and Source an address or a CIDR");
  if (protocol === "udp" && key.startsWith(`${PANEL_PORT} `)) {
    failAction(`CloudPanel itself is on port ${PANEL_PORT}, which UDP alone would close to TCP; choose TCP and UDP`);
  }
  const now = (options.now ?? Date.now)();
  withFileLockSync(paths.lockFile, 30, "another firewall change is still running", () => {
    const state = readFirewallState(paths);
    if ((state.protocols[key] ?? "tcp") === protocol) return;
    const matching = readPanelRules(paths.panelDb).filter((rule) => ruleKey(rule.portRange, rule.source) === key);
    // Another rule has this port range and source, which this form would change too.
    if (matching.length && !matching.some((rule) => rule.id === body.id)) {
      failAction(`a rule for ${key.replace(" ", " from ")} already exists; set its protocol on that rule's edit page`);
    }
    delete state.unmatched[key];
    if (protocol === "tcp") delete state.protocols[key];
    else {
      state.protocols[key] = protocol;
      if (!matching.length) state.unmatched[key] = now;
    }
    writeFirewallState(paths, state);
  });
}
