/**
 * CloudPanel's clp-agent records the dashboard's CPU, memory, load and disk
 * graphs, and once a day posts the server's ID and hardware, every site's
 * domain and every panel user's name and email to ing.cloudpanel.io. A
 * drop-in denies the unit every address but loopback, so the graphs keep
 * working and nothing leaves the server. The package ships the unit under
 * /lib, so the drop-in under /etc survives CloudPanel updates.
 */
import { errorMessage } from "../../lib/errors";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { runCommand, type CommandResult } from "../../lib/command";
import { writeFileAtomic } from "../../lib/atomic-write";
import { COMMAND_MS, TELEMETRY_GATEWAY_TIMEOUT_MS } from "./limits";
import { applyThenSave, tweak } from "./tweak";
import { badge, statusLine, switchRow } from "./app/rows";
import { esc } from "../../lib/app-http";

const DEFAULT_TELEMETRY_PATHS = {
  dropIn: "/etc/systemd/system/clp-agent.service.d/zz-clp-addons-telemetry.conf",
  unit: "clp-agent.service",
  systemctl: "systemctl",
  systemdRun: "systemd-run",
  bash: "/bin/bash",
};

const TELEMETRY_DROP_IN = `# clp-addons System Tweaks: Block CloudPanel telemetry. Switching it off removes this file.
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
 * documentation address. The filter is enforced when that send is refused and
 * the same send outside it is not.
 */
const PROBE_SCRIPT = 'if r=$({ echo > /dev/udp/192.0.2.1/9; } 2>&1); then echo clp-addons-probe:sent; else echo "clp-addons-probe:refused:$r"; fi';
const FILTERED_PROBE = ["--quiet", "--wait", "--collect", "--pipe", "-p", "IPAddressDeny=any", "-p", "IPAddressAllow=localhost",
  "/bin/bash", "-c", PROBE_SCRIPT];

type ProbeResult = "sent" | "refused" | "other";

function probe(result: CommandResult): ProbeResult | null {
  if (result.stdout.includes("clp-addons-probe:sent")) return "sent";
  const refused = result.stdout.match(/clp-addons-probe:refused:(.*)/);
  if (!refused) return null;
  return refused[1]!.includes("Operation not permitted") ? "refused" : "other";
}

function enforcementProblem(ctx: ReturnType<typeof context>): string {
  const filtered = ctx.run(ctx.paths.systemdRun, FILTERED_PROBE);
  const inside = probe(filtered);
  if (inside === null) return `whether the block is enforced could not be checked: ${filtered.stderr.trim() || "systemd-run failed"}`;
  if (inside === "sent") return "systemd loaded the block, but this kernel or container does not enforce IP filters, so clp-agent can still send";
  if (inside === "other") return `whether the block is enforced could not be checked: ${filtered.stdout.trim()}`;
  if (probe(ctx.run(ctx.paths.bash, ["-c", PROBE_SCRIPT])) !== "sent") {
    return "whether the block is enforced could not be checked: something else on this server also refuses the test send";
  }
  return "";
}

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
    const problem = enforcementProblem(ctx);
    return { agent, blocked: problem === "", problem };
  } catch (error) {
    return { agent: false, blocked: false, problem: errorMessage(error) };
  }
}

/** A running agent takes its address filter only when it starts. */
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

type TelemetryState = TelemetryStatus & { enabled: boolean };

function telemetryLine(state: TelemetryState): string {
  if (state.problem) return `${badge("Unknown", "warn")} <span>${esc(state.problem)}</span>`;
  if (!state.agent) return `${badge("No agent", "plain")} <span>CloudPanel's clp-agent is not installed here.</span>`;
  if (state.blocked) return `${badge("Blocked", "ok")} <span>clp-agent can reach only this server.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Sending", "plain")} <span>clp-agent sends CloudPanel every site's domain and every panel user's name and email once a day.</span>`;
}

/** Deny CloudPanel's clp-agent every address but loopback. */
export const TELEMETRY_TWEAK = tweak<{ blockTelemetry: boolean }, { telemetry?: TelemetryOptions }, { telemetry: TelemetryState }>()({
  defaults: { blockTelemetry: true },
  state: ({ options, settings }) => ({ telemetry: { ...telemetryStatus(options.telemetry), enabled: settings.blockTelemetry } }),
  switch: {
    verb: "set-telemetry",
    key: "blockTelemetry",
    timeout: TELEMETRY_GATEWAY_TIMEOUT_MS,
    set: applyThenSave("blockTelemetry", (on, options: { telemetry?: TelemetryOptions }) => applyTelemetryBlock(on, options.telemetry)),
  },
  repair: {
    block: {
      label: "CloudPanel telemetry",
      locked: true,
      run: ({ options, settings }) => settings.blockTelemetry && applyTelemetryBlock(true, options.telemetry) && "CloudPanel telemetry blocked again",
    },
  },
  withdraw: {
    run: ({ options }) => { applyTelemetryBlock(false, options.telemetry); },
    warning: (error) => `clp-agent is still blocked from the network: ${error}; remove ${DEFAULT_TELEMETRY_PATHS.dropIn}`,
  },
  restore: {
    run: ({ options, settings }) => { if (settings.blockTelemetry) applyTelemetryBlock(true, options.telemetry); },
    warning: (error) => `blocking CloudPanel telemetry waits for the next repair: ${error}`,
  },
  row: ({ telemetry }, locked) => switchRow("set-telemetry", {
    key: "blockTelemetry",
    title: "Block CloudPanel telemetry",
    description: [
      "Cuts CloudPanel's clp-agent off from the network, so it stops sending the server's ID and hardware, every site's domain and every panel user's name and email.",
      "The agent keeps recording the dashboard's graphs.",
    ],
    checked: telemetry.enabled,
    extra: statusLine(telemetryLine(telemetry)),
  }, locked),
});
