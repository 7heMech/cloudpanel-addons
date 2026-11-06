/**
 * CloudPanel's clp-agent records the dashboard's CPU, memory, load and disk
 * graphs, and once a day posts the server's ID and hardware, every site's
 * domain and every panel user's name and email to ing.cloudpanel.io. A
 * drop-in denies the unit every address but loopback, so the graphs keep
 * working and nothing leaves the server. The package ships the unit under
 * /lib, so the drop-in under /etc survives CloudPanel updates.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { runCommand, type CommandResult } from "../../cli/action-common";
import { writeFileAtomic } from "../../lib/atomic-write";
import { COMMAND_MS } from "./limits";

export const DEFAULT_TELEMETRY_PATHS = {
  dropIn: "/etc/systemd/system/clp-agent.service.d/zz-clp-addons-telemetry.conf",
  unit: "clp-agent.service",
  systemctl: "systemctl",
  systemdRun: "systemd-run",
};

export const TELEMETRY_DROP_IN = `# clp-addons System Tweaks: Block CloudPanel telemetry. Switching it off removes this file.
[Service]
IPAddressDeny=any
IPAddressAllow=localhost
`;

export interface TelemetryOptions {
  paths?: Partial<typeof DEFAULT_TELEMETRY_PATHS>;
  run?: (command: string, args: string[]) => CommandResult;
}

export interface TelemetryStatus {
  /** CloudPanel's clp-agent unit is installed. */
  agent: boolean;
  /** systemd has loaded the drop-in and this kernel enforces it, so the agent can reach only this server. */
  blocked: boolean;
  problem: string;
}

/**
 * systemd ignores IPAddressDeny= where the kernel or a container manager offers
 * no cgroup BPF, so a unit with the same filter sends one UDP datagram to a
 * documentation address: refused means the filter is enforced.
 */
const PROBE = ["--quiet", "--wait", "--collect", "--pipe", "-p", "IPAddressDeny=any", "-p", "IPAddressAllow=localhost",
  "/bin/bash", "-c", "echo > /dev/udp/192.0.2.1/9"];

function context(options: TelemetryOptions) {
  const paths = { ...DEFAULT_TELEMETRY_PATHS, ...options.paths };
  const run = options.run ?? ((command: string, args: string[]) => runCommand(command, args, COMMAND_MS));
  return { paths, run };
}

function show(ctx: ReturnType<typeof context>): { agent: boolean; loaded: boolean } {
  const result = ctx.run(ctx.paths.systemctl, ["show", ctx.paths.unit, "-p", "LoadState", "-p", "IPAddressDeny", "-p", "DropInPaths"]);
  if (!result.ok) throw new Error(`systemctl show ${ctx.paths.unit} failed: ${result.stderr.trim() || "no output"}`);
  const values = new Map(result.stdout.split("\n").map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1).trim()] as const;
  }));
  return {
    agent: values.get("LoadState") === "loaded",
    loaded: (values.get("IPAddressDeny") ?? "") !== "" && (values.get("DropInPaths") ?? "").split(/\s+/).includes(ctx.paths.dropIn),
  };
}

function dropInInPlace(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8") === TELEMETRY_DROP_IN;
}

export function telemetryStatus(options: TelemetryOptions = {}): TelemetryStatus {
  const ctx = context(options);
  try {
    const { agent, loaded } = show(ctx);
    if (!agent || !loaded || !dropInInPlace(ctx.paths.dropIn)) return { agent, blocked: false, problem: "" };
    const probe = ctx.run(ctx.paths.systemdRun, PROBE);
    if (!probe.ok && probe.stderr.includes("Operation not permitted")) return { agent, blocked: true, problem: "" };
    return {
      agent, blocked: false,
      problem: probe.ok
        ? "systemd loaded the block, but this kernel or container does not enforce IP filters, so clp-agent can still send"
        : `whether the block is enforced could not be checked: ${probe.stderr.trim() || "systemd-run failed"}`,
    };
  } catch (error) {
    return { agent: false, blocked: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Reloads systemd and restarts a running agent, since its address filter is set when it starts. */
function reload(ctx: ReturnType<typeof context>): void {
  const daemon = ctx.run(ctx.paths.systemctl, ["daemon-reload"]);
  if (!daemon.ok) throw new Error(`systemctl daemon-reload failed: ${daemon.stderr.trim()}`);
  if (!show(ctx).agent) return;
  const restart = ctx.run(ctx.paths.systemctl, ["try-restart", ctx.paths.unit]);
  if (!restart.ok) throw new Error(`systemctl try-restart ${ctx.paths.unit} failed: ${restart.stderr.trim()}`);
}

/** Puts the drop-in in the wanted state; returns whether anything changed. */
export function applyTelemetryBlock(block: boolean, options: TelemetryOptions = {}): boolean {
  const ctx = context(options);
  if (!block) {
    if (!existsSync(ctx.paths.dropIn)) return false;
    rmSync(ctx.paths.dropIn, { force: true });
    reload(ctx);
    return true;
  }
  if (dropInInPlace(ctx.paths.dropIn)) {
    const { agent, loaded } = show(ctx);
    if (!agent || loaded) return false;
  } else {
    writeFileAtomic(ctx.paths.dropIn, TELEMETRY_DROP_IN, { mode: 0o644, createParent: true });
  }
  reload(ctx);
  return true;
}
