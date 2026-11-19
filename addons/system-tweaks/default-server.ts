// Whether the sites' Nginx refuses hostnames it has no site for. CloudPanel
// ships /etc/nginx/sites-enabled/default.conf for it: default_server on 80 and
// 443 that rejects the TLS handshake and returns 444. Without it, the first
// site's server block answers any name pointed at this server, PHP included.
import type { ActionNeeded } from "../../lib/addon-definition";

export const DEFAULT_SERVER_GUIDE = "https://github.com/7heMech/cloudpanel-addons/blob/main/docs/system-tweaks.md#unknown-hostnames";

interface ServerBlock {
  file: string;
  names: string[];
  listens: { key: string; port: number; defaultServer: boolean }[];
  refuses: boolean;
  rejectsHandshake: boolean;
  /** At the top of a file no traced `include` brought in, so it may be a stream or mail server. */
  uncertain: boolean;
}

/** A quoted string, a comment to the end of the line, a brace or semicolon, or a word. */
const TOKEN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|[{};]|[^\s{};"']+/g;

/**
 * The `server` blocks of `http`, from `nginx -T`, in the order Nginx reads them.
 * It prints each file whole, after the one that includes it, so a file's
 * context is that of the `include` that matches it: a vhost's server block is
 * at the top of its own file, in `http` because its `include` is.
 */
export function serverBlocks(dump: string): ServerBlock[] {
  const blocks: ServerBlock[] = [];
  const includes: { pattern: string; context: string[] | null }[] = [];
  const stack: string[] = [];
  let prefix = "/etc/nginx/";
  let base: string[] | null = [];
  let file = "";
  let first = true;
  let current: ServerBlock | null = null;
  let words: string[] = [];
  for (const line of dump.split("\n")) {
    const header = /^# configuration file (.+):$/.exec(line);
    if (header) {
      file = header[1]!;
      if (first) prefix = file.slice(0, file.lastIndexOf("/") + 1);
      base = first ? [] : includes.find((include) => new Bun.Glob(include.pattern).match(file))?.context ?? null;
      first = false;
      stack.length = 0;
      current = null;
      words = [];
      continue;
    }
    for (const token of line.match(TOKEN) ?? []) {
      if (token.startsWith("#")) break;
      if (token === "{") {
        const name = words[0] ?? "";
        const context = base && [...base, ...stack];
        if (name === "server" && (context ? context.length === 1 && context[0] === "http" : stack.length === 0)) {
          current = { file, names: [], listens: [], refuses: false, rejectsHandshake: false, uncertain: context === null };
          blocks.push(current);
        }
        stack.push(name);
        words = [];
      } else if (token === "}") {
        if (stack.pop() === "server") current = null;
        words = [];
      } else if (token === ";") {
        if (current && stack.at(-1) === "server") directive(current, words);
        else if (words[0] === "include" && words[1]) {
          const pattern = words[1].replace(/^["']|["']$/g, "");
          includes.push({ pattern: pattern.startsWith("/") ? pattern : prefix + pattern, context: base && [...base, ...stack] });
        }
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
  const blocks = serverBlocks(dump);
  // A file whose context cannot be traced could be a stream or mail server; a false Action needed cannot be cleared.
  if (blocks.some((block) => block.uncertain && block.listens.some((listen) => listen.port === 80 || listen.port === 443))) return [];
  const groups = new Map<string, { port: number; blocks: ServerBlock[]; chosen: ServerBlock | null }>();
  for (const block of blocks) {
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

export async function defaultServerCheck(options: { dump?: () => string | null | Promise<string | null> } = {}): Promise<ActionNeeded[]> {
  const dump = await (options.dump ?? nginxDump)();
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

/** Spawned, not run synchronously, so Setup's time limit can leave it behind. */
async function nginxDump(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["nginx", "-T"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 8000, killSignal: "SIGKILL" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}
