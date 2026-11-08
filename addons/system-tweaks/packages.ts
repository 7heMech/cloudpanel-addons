import { failAction } from "../../lib/action";
import { commandOutput, runCommand, type CommandResult } from "../../lib/command";
import { APT_STEP_MS, COMMAND_MS } from "./limits";

/** A command runner; `timeoutMs` overrides the command's own guard. */
export type Run =(command: string, args: string[], env?: Record<string, string>, timeoutMs?: number) => CommandResult;

function guardOf(command: string): number {
  return command === "apt-get" ? APT_STEP_MS : COMMAND_MS;
}

export function systemRun(command: string, args: string[], env?: Record<string, string>, timeoutMs?: number): CommandResult {
  return runCommand(command, args, timeoutMs ?? guardOf(command), env);
}

export function withDeadline(run: Run, deadline: number, now: () => number = Date.now, what = "unattended-upgrades"): Run {
  return (command, args, env) => {
    const remaining = deadline - now();
    if (remaining <= 0) failAction(`the install ran out of time; try again, or install ${what} with apt`);
    return run(command, args, env, Math.min(guardOf(command), remaining));
  };
}

/**
 * The installed version of a package, or "" when it is not installed. dpkg's
 * status ends in `installed` for one that is, held back (`hold ok installed`)
 * or not; `half-installed` and the rest do not.
 */
export function installedVersion(run: Run, name: string): string {
  const query = run("dpkg-query", ["-W", "-f=${Status}\t${Version}", name]);
  const [status = "", version = ""] = query.stdout.split("\t");
  return query.ok && status.endsWith(" installed") ? version.trim() : "";
}

export function aptInstall(run: Run, packages: string[]): void {
  const env = { DEBIAN_FRONTEND: "noninteractive" };
  const install = () => run("apt-get", ["install", "-y", "-o", "DPkg::Lock::Timeout=120", ...packages], env);
  let result = install();
  if (!result.ok) {
    run("apt-get", ["update", "-o", "DPkg::Lock::Timeout=120"], env);
    result = install();
  }
  if (!result.ok) failAction(`apt-get could not install ${packages.join(", ")}: ${commandOutput(result, 3)}`);
}
