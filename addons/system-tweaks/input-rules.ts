/**
 * What the loaded `INPUT` rules do with a new TCP connection to one port from
 * outside: an address that is not this box, on an interface that is not
 * loopback. It reads `iptables-save -t filter` (or ip6tables-save) and follows
 * the rules in order, jumps included, as the kernel would. A rule it cannot
 * read is allowed to drop, since that can only close the port further; one
 * that could accept makes the answer unknown.
 */

export type InputVerdict =
  | { verdict: "drop"; openTo: string[] }
  | { verdict: "accept" }
  | { verdict: "unknown"; reason: string };

interface Rule { text: string; tokens: string[] }
interface Table { policies: Map<string, string>; chains: Map<string, Rule[]> }

/** Splits a rule as iptables-save writes it, keeping quoted comments whole. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) tokens.push(match[1] ?? match[2]!);
  return tokens;
}

export function parseFilterTable(save: string): Table | null {
  const table: Table = { policies: new Map(), chains: new Map() };
  let inFilter = false;
  for (const line of save.split("\n")) {
    if (line.startsWith("*")) { inFilter = line.trim() === "*filter"; continue; }
    if (!inFilter) continue;
    const chain = /^:(\S+) (\S+)/.exec(line);
    if (chain) {
      table.chains.set(chain[1]!, []);
      if (chain[2] !== "-") table.policies.set(chain[1]!, chain[2]!);
      continue;
    }
    if (line.startsWith("-A ")) {
      const [, name = "", ...tokens] = tokenize(line);
      table.chains.get(name)?.push({ text: line.slice(3), tokens });
    }
  }
  return table.chains.has("INPUT") ? table : null;
}

/** How a rule's conditions meet the packet: never, for every outside client, for some, or unreadable. */
type Match = { kind: "no" } | { kind: "all" | "some"; label: string | null } | { kind: "uncertain" };

const NON_TERMINATING = new Set(["", "LOG", "NFLOG", "ULOG", "MARK", "CONNMARK", "TRACE", "AUDIT", "TCPMSS", "SET", "CHECKSUM", "CLASSIFY", "DSCP", "TOS"]);

function portIn(spec: string, port: number): boolean {
  return spec.split(",").some((part) => {
    const [from = NaN, to = from] = part.split(":").map(Number);
    return port >= from && port <= to;
  });
}

function loopbackAddress(cidr: string): boolean {
  return /^127\./.test(cidr) || cidr === "::1/128" || cidr === "::1";
}

function multicast(cidr: string): boolean {
  return /^(?:22[4-9]|23\d|255)\./.test(cidr) || /^ff/i.test(cidr);
}

function shortAddress(cidr: string): string {
  return cidr.replace(/\/(?:32|128)$/, "");
}

function matchRule(tokens: string[], port: number): { match: Match; target: string; jumpKind: "-j" | "-g" } {
  const labels: string[] = [];
  let some = false;
  let uncertain = false;
  let never = false;
  let target = "";
  let jumpKind: "-j" | "-g" = "-j";
  for (let i = 0; i < tokens.length; i++) {
    let negate = false;
    if (tokens[i] === "!") { negate = true; i++; }
    const option = tokens[i] ?? "";
    const value = tokens[i + 1] ?? "";
    const yes = (matches: boolean) => { if (matches === negate) never = true; i++; };
    switch (option) {
      case "-j": case "-g":
        target = value; jumpKind = option; i++;
        // Everything after the target is its own options, such as --reject-with.
        i = tokens.length;
        break;
      case "-p": case "--protocol":
        yes(["tcp", "6", "all", "0"].includes(value.toLowerCase())); break;
      case "-s": case "--source":
        if (!negate && loopbackAddress(value)) never = true;
        else if (!negate || !loopbackAddress(value)) labels.push(`${negate ? "not " : ""}from ${shortAddress(value)}`);
        i++; break;
      case "-d": case "--destination":
        if (!negate && multicast(value)) never = true;
        else labels.push(`${negate ? "not " : ""}to ${shortAddress(value)}`);
        i++; break;
      case "-i": case "--in-interface":
        if (value === "lo") { if (!negate) never = true; }
        else labels.push(`${negate ? "not " : ""}on ${value}`);
        i++; break;
      case "-m": case "--match": i++; break;
      case "--dport": case "--destination-port": case "--dports": case "--destination-ports":
        yes(portIn(value, port)); break;
      // The client picks its own source port.
      case "--sport": case "--source-port": case "--sports": case "--source-ports": i++; break;
      case "--ctstate": case "--state":
        yes(value.split(",").includes("NEW")); break;
      case "--dst-type": yes(value.split(",").some((type) => type === "LOCAL" || type === "UNICAST")); break;
      case "--src-type": yes(value.split(",").some((type) => type === "UNICAST")); break;
      case "--rt-type": if (!negate) never = true; i++; break;
      case "--comment": case "--name": case "--mask": case "--limit-burst": case "--seconds": case "--hitcount": i++; break;
      case "--limit": case "--hl-eq": case "--hl-lt": case "--hl-gt": case "--ttl-eq": case "--ttl-lt": case "--ttl-gt":
        some = true; i++; break;
      case "--set": case "--update": case "--rcheck": case "--rsource": case "--rttl": case "--remove":
        some = true; break;
      case "--icmp-type": case "--icmpv6-type": i++; break;
      default:
        uncertain = true;
        if (value && !value.startsWith("-") && value !== "!") i++;
    }
  }
  if (never) return { match: { kind: "no" }, target, jumpKind };
  if (uncertain) return { match: { kind: "uncertain" }, target, jumpKind };
  const label = labels.length ? labels.join(" ") : null;
  return { match: { kind: some ? "some" : "all", label }, target, jumpKind };
}

type Walk = "accept" | "drop" | "return" | { unknown: string };

/**
 * Follows `chain` for the clients `label` names (null: every outside client).
 * What a narrower rule lets in goes into `openTo`; only a rule that covers the
 * whole group ends the walk for it.
 */
function walk(table: Table, chain: string, port: number, label: string | null, openTo: Set<string>, depth: number): Walk {
  if (depth > 32) return { unknown: "the firewall rules jump too deep to follow" };
  for (const rule of table.chains.get(chain) ?? []) {
    const { match, target, jumpKind } = matchRule(rule.tokens, port);
    if (match.kind === "no" || NON_TERMINATING.has(target)) continue;
    const terminal = target === "DROP" || target === "REJECT";
    if (match.kind === "uncertain") {
      if (terminal) continue;
      return { unknown: `the loaded rule "${rule.text}" could not be read` };
    }
    const scope = [label, match.label].filter(Boolean).join(" ") || null;
    // Applies to only part of the group: some sources or interfaces, or some packets.
    const partial = match.kind === "some" || match.label !== null;
    if (target === "ACCEPT") {
      // Accepted even sometimes from anywhere is open.
      if (scope === null) return "accept";
      openTo.add(`${port} ${scope}`);
      if (partial) continue;
      return "drop";
    }
    if (terminal) {
      if (partial) continue;
      return "drop";
    }
    if (target === "RETURN") {
      if (partial) return { unknown: `the loaded rule "${rule.text}" returns for only some clients` };
      return "return";
    }
    if (!table.chains.has(target) || table.policies.has(target)) return { unknown: `the loaded rule "${rule.text}" goes to ${target}` };
    const inner = walk(table, target, port, scope, openTo, depth + 1);
    if (typeof inner === "object") return inner;
    if (partial) {
      if (inner === "accept") return "accept";
      continue;
    }
    if (inner === "return") {
      if (jumpKind === "-g") return "return";
      continue;
    }
    return inner;
  }
  const policy = table.policies.get(chain);
  if (!policy) return "return";
  // A built-in chain's policy settles whoever reaches its end.
  if (policy === "ACCEPT") return label === null ? "accept" : (openTo.add(`${port} ${label}`), "drop");
  return "drop";
}

/** The loaded ruleset's verdict on a new TCP connection to `port` from outside. */
export function inputVerdict(table: Table, port: number): InputVerdict {
  const openTo = new Set<string>();
  const result = walk(table, "INPUT", port, null, openTo, 0);
  if (typeof result === "object") return { verdict: "unknown", reason: result.unknown };
  if (result === "accept") return { verdict: "accept" };
  return { verdict: "drop", openTo: [...openTo] };
}

/** Base chains on the input hook outside the tables iptables-nft keeps, from `nft list chains`. */
export function otherInputHooks(chains: string): string[] {
  const found: string[] = [];
  let table = "";
  let chain = "";
  for (const raw of chains.split("\n")) {
    const line = raw.trim();
    const header = /^table (\S+ \S+)/.exec(line);
    if (header) { table = header[1]!; continue; }
    const named = /^chain (\S+)/.exec(line);
    if (named) { chain = named[1]!; continue; }
    if (/\bhook input\b/.test(line) && table !== "ip filter" && table !== "ip6 filter") found.push(`${table} ${chain}`);
  }
  return found;
}
