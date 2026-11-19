// Whether the sites' Nginx refuses hostnames it has no site for. CloudPanel
// ships /etc/nginx/sites-enabled/default.conf for it: default_server on 80 and
// 443 that rejects the TLS handshake and returns 444. Without it, the first
// site's server block answers any name pointed at this server, PHP included.
import type { ActionNeeded } from "../../lib/addon-definition";
import { runCommand } from "../../lib/command";

export const DEFAULT_SERVER_GUIDE = "https://github.com/7heMech/cloudpanel-addons/blob/main/docs/system-tweaks.md#unknown-hostnames";

interface ServerBlock {
  file: string;
  names: string[];
  listens: { key: string; port: number; defaultServer: boolean }[];
  refuses: boolean;
  rejectsHandshake: boolean;
}

/** A quoted string, a comment to the end of the line, a brace or semicolon, or a word. */
const TOKEN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|[{};]|[^\s{};"']+/g;

/**
 * The `server` blocks of `http`, from `nginx -T`, in the order Nginx reads them.
 * It prints each file whole, after the one that includes it, so a vhost's
 * server block is at the top of its own file rather than inside `http`.
 */
export function serverBlocks(dump: string): ServerBlock[] {
  const blocks: ServerBlock[] = [];
  const stack: string[] = [];
  let file = "";
  let current: ServerBlock | null = null;
  let words: string[] = [];
  for (const line of dump.split("\n")) {
    const header = /^# configuration file (.+):$/.exec(line);
    if (header) {
      file = header[1]!;
      stack.length = 0;
      current = null;
      words = [];
      continue;
    }
    for (const token of line.match(TOKEN) ?? []) {
      if (token.startsWith("#")) break;
      if (token === "{") {
        const name = words[0] ?? "";
        stack.push(name);
        if (name === "server" && (stack.length === 1 || (stack.length === 2 && stack[0] === "http"))) {
          current = { file, names: [], listens: [], refuses: false, rejectsHandshake: false };
          blocks.push(current);
        }
        words = [];
      } else if (token === "}") {
        if (stack.pop() === "server" && stack.length <= 1) current = null;
        words = [];
      } else if (token === ";") {
        if (current && stack.at(-1) === "server") directive(current, words);
        words = [];
      } else {
        words.push(token);
      }
    }
  }
  return blocks;
}

function directive(block: ServerBlock, [name, ...args]: string[]): void {
  if (name === "server_name") block.names.push(...args);
  else if (name === "return" && args[0] === "444") block.refuses = true;
  else if (name === "ssl_reject_handshake" && args[0] === "on") block.rejectsHandshake = true;
  else if (name === "listen" && args[0]) {
    const address = args[0];
    const port = Number(/(?:^|:)(\d+)$/.exec(address)?.[1] ?? NaN);
    const host = address.includes(":") ? address.slice(0, address.lastIndexOf(":")) : "";
    // A listener on one address is a group of its own; only the wildcard ones answer any name pointed here.
    if (!["", "*", "0.0.0.0", "[::]"].includes(host) || !Number.isInteger(port)) return;
    const family = host === "[::]" ? "ipv6" : "ipv4";
    const quic = args.includes("quic") ? " quic" : "";
    block.listens.push({ key: `${family} ${port}${quic}`, port, defaultServer: args.includes("default_server") || args.includes("default") });
  }
}

/** For each wildcard listener on 80 and 443, why the server answering unknown names does not refuse them. */
export function defaultServerProblems(dump: string): string[] {
  const groups = new Map<string, { port: number; blocks: ServerBlock[]; chosen: ServerBlock | null }>();
  for (const block of serverBlocks(dump)) {
    for (const listen of block.listens) {
      if (listen.port !== 80 && listen.port !== 443) continue;
      const group = groups.get(listen.key) ?? { port: listen.port, blocks: [], chosen: null };
      group.blocks.push(block);
      if (listen.defaultServer && !group.chosen) group.chosen = block;
      groups.set(listen.key, group);
    }
  }
  const problems = new Set<string>();
  for (const group of groups.values()) {
    const answering = group.chosen ?? group.blocks[0]!;
    const refuses = answering.refuses && (group.port === 80 || answering.rejectsHandshake);
    if (refuses) continue;
    const who = answering.names.find((name) => name !== "_") ?? answering.file ?? "a server block";
    problems.add(`On port ${group.port}, ${who} answers them`);
  }
  return [...problems];
}

export function defaultServerCheck(options: { dump?: () => string | null } = {}): ActionNeeded[] {
  const dump = options.dump?.() ?? nginxDump();
  // Nginx's config not loading is louder elsewhere; this check needs the config it would run.
  if (dump === null) return [];
  const problems = defaultServerProblems(dump);
  if (!problems.length) return [];
  return [{
    title: "Unknown hostnames reach a site",
    reason: `${problems.join("; ")}, so any domain pointed at this server, even another Cloudflare account's, reaches that site's PHP`,
    href: DEFAULT_SERVER_GUIDE,
  }];
}

function nginxDump(): string | null {
  const result = runCommand("nginx", ["-T"], 8000);
  return result.ok ? result.stdout : null;
}
