import { chmodSync, chownSync, existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  ADDON_NAMES, ADDONS, CLI_ARTIFACT, CLI_BIN, HMAC_KEY_PATH, LIBEXEC_DIR, MANAGER_UNIT, PANEL_GROUP,
  SESSION_VALIDATOR_ARTIFACT, SOCKET_PATH, mountPath, type AddonSpec,
} from "./paths";
import { CLI_VERSION, fetchVerified, loadLocal, resolveRelease, verifyAttestation, type FetchedArtifact } from "./release";
import {
  ensureDirs, ensureHmacKey, ensureServiceUser, ensureTimerArmed, hardenBackups, installSessionValidator,
  installSudoers, installUnits, installWrapper, installedConfig, purgeTwigCache, removeLegacyUnits,
  removeLegacyInstall, removeLegacyUsers, removeSudoers, startUnits, stopUnits, unitActive, unitPid, writeConfig,
} from "./provision";
import {
  KNOWN_GOOD_PANEL_VERSIONS, inspect, inspectNginxProxy, masterVhostHost, panelVersion, purgeTwigCache as purgeInjectCache,
  reconcile, reconcileNginxProxy, type Injection, type NginxProxyStatus, type TargetStatus,
} from "./inject";
import { fatal, Fatal, log, parseFlags, requireRoot, tryRun, writeAtomic } from "./util";
import { generateSnapshot } from "../lib/panel-snapshot";
import { authenticateRequest } from "../lib/sso-auth";
import { handle as handleInstatic } from "../addons/instatic/app/index";
import { handle as handleStager } from "../addons/stager/app/index";
import { splitMount } from "../lib/mount";
import { SECURITY_HEADERS, esc } from "../lib/app-http";
import { renderLayout } from "../lib/app-ui";
import { checkCliUpdate } from "../lib/update-check";

type AddonHandler = (
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
) => Promise<Response>;

const MANAGERS: Record<string, AddonHandler> = {
  instatic: handleInstatic,
  stager: handleStager,
};

function resolveAddon(name: string | undefined): AddonSpec {
  const key = name ?? "";
  const spec = ADDONS[key];
  if (!spec) fatal(`unknown addon '${key}'. Available: ${ADDON_NAMES.join(", ")}`);
  return spec;
}

function installedAddons(): AddonSpec[] {
  return ADDON_NAMES.map((name) => ADDONS[name]!).filter(installedConfig);
}

function artifactNames(specs: AddonSpec[]): string[] {
  return [...new Set([
    CLI_ARTIFACT,
    SESSION_VALIDATOR_ARTIFACT,
    ...specs.map((spec) => spec.wrapperArtifact),
  ])];
}

function artifact(artifacts: FetchedArtifact[], name: string): Buffer {
  const found = artifacts.find((item) => item.name === name);
  if (!found) fatal(`release did not contain ${name}`);
  return found.bytes;
}

function installArtifacts(artifacts: FetchedArtifact[], specs: AddonSpec[], quiet = false): void {
  for (const spec of specs) installWrapper(spec, artifact(artifacts, spec.wrapperArtifact), quiet);
  installSessionValidator(artifact(artifacts, SESSION_VALIDATOR_ARTIFACT), quiet);
  writeAtomic(CLI_BIN, artifact(artifacts, CLI_ARTIFACT), 0o755);
  tryRun("chown", ["root:root", CLI_BIN]);
}

function installedInjections(exclude?: string): Injection[] {
  const injections: Injection[] = [];
  for (const name of ADDON_NAMES) {
    if (name === exclude) continue;
    const spec = ADDONS[name]!;
    if (!existsSync(spec.configFile)) continue;
    for (const target of spec.targets) injections.push({
      addon: name,
      target,
      url: mountPath(name),
    });
  }
  return injections;
}

function describeTarget(status: TargetStatus): string {
  switch (status.state) {
    case "ok": return "patched";
    case "missing-anchor": return "missing; repair will re-inject";
    case "stale-content": return "stale; repair will rewrite it";
    case "template-absent": return "template not found";
    case "anchor-not-found-in-markup": return "anchor markup not found";
    case "upstream-changed": return `upstream changed (${status.found.slice(0, 12)})`;
  }
}

function reconcileAnchors(quiet: boolean, exclude?: string): boolean {
  const injections = installedInjections(exclude);
  const wanted = new Map(injections.map((injection) => [`${injection.addon}:${injection.target.slug}`, injection]));
  const result = reconcile(injections);
  let blocked = false;
  for (const status of result.statuses) {
    const injection = wanted.get(`${status.addon}:${status.slug}`);
    if (!injection) continue;
    if (status.state === "ok") {
      if (!quiet) log.ok(`${status.addon}/${status.slug} patched`);
      continue;
    }
    if (status.state === "template-absent") {
      if (!quiet) log.warn(`${status.addon}/${status.slug}: ${describeTarget(status)}`);
      continue;
    }
    log.err(`${status.addon}/${status.slug}: ${describeTarget(status)}`);
    if (status.state === "upstream-changed" || status.state === "anchor-not-found-in-markup") {
      log.err(`CloudPanel ${panelVersion()} changed the target markup; known good: ${KNOWN_GOOD_PANEL_VERSIONS.join(", ")}`);
    }
    if (injection.target.required) blocked = true;
  }
  if (result.changed) {
    purgeInjectCache();
    if (!quiet) log.ok("Twig cache purged");
  }
  return !blocked;
}

function reconcileNginx(quiet: boolean, enabled = true): boolean {
  const result = reconcileNginxProxy({ enabled });
  if (result.state === "ok" || (!enabled && result.state === "missing")) {
    if (result.changed && !quiet) log.ok(enabled ? "Nginx proxy injected and verified" : "Nginx proxy removed and verified");
    return true;
  }
  log.err(`Nginx proxy: ${result.detail ?? result.state}`);
  return false;
}

function dashboardUrl(): string {
  const host = masterVhostHost() ?? "<cloudpanel-host>";
  return `https://${host}/addons/`;
}

async function cmdInstall(argv: string[]): Promise<void> {
  requireRoot("install");
  const { positional, flags } = parseFlags(argv);
  const spec = resolveAddon(positional[0]);
  for (const unit of spec.requiresUnits ?? []) {
    if (!tryRun("systemctl", ["is-active", unit]).ok) {
      fatal(`${unit} is not active; install and start it before installing ${spec.name}`);
    }
  }

  const specs = [...installedAddons().filter((item) => item.name !== spec.name), spec];
  const names = artifactNames(specs);
  let artifacts: FetchedArtifact[];
  if (typeof flags.local === "string") {
    artifacts = loadLocal(flags.local, names);
  } else {
    const release = await resolveRelease(
      typeof flags.version === "string" ? flags.version : "latest",
      flags["allow-prerelease"] === true,
    );
    artifacts = await fetchVerified(release, names);
    await verifyAttestation(release, artifacts, flags["skip-attestation"] === true);
  }

  ensureServiceUser();
  removeLegacyInstall();
  ensureDirs(specs);
  ensureHmacKey();
  installArtifacts(artifacts, specs);
  for (const item of specs) writeConfig(item, true);
  installSudoers();
  installUnits(specs);
  removeLegacyUnits(true);
  removeLegacyUsers(true);
  generateSnapshot();
  ensureDirs(specs);
  reconcileAnchors(false);
  if (!reconcileNginx(false)) fatal("could not safely inject the CloudPanel Nginx proxy");
  startUnits();

  log.plain();
  log.ok(`${spec.name} installed`);
  log.plain(`  Dashboard URL: ${dashboardUrl()}`);
}

export async function cmdUpdate(argv: string[]): Promise<void> {
  requireRoot("update");
  const { flags } = parseFlags(argv);
  const release = await resolveRelease(
    typeof flags.version === "string" ? flags.version : "latest",
    flags["allow-prerelease"] === true,
  );
  const current = CLI_VERSION.replace(/^v/, "");
  const target = release.tag.replace(/^v/, "");

  const specs = installedAddons();
  const upToDate = current === target;
  let artifacts: FetchedArtifact[] | undefined;
  if (!upToDate) {
    artifacts = await fetchVerified(release, artifactNames(specs));
    await verifyAttestation(release, artifacts, flags["skip-attestation"] === true);
  }

  ensureServiceUser();
  removeLegacyInstall();
  ensureDirs(specs);
  ensureHmacKey();
  if (artifacts) installArtifacts(artifacts, specs);
  for (const spec of specs) writeConfig(spec, true);
  installSudoers();
  removeLegacyUnits(true);
  removeLegacyUsers(true);
  if (specs.length === 0) {
    log.ok(upToDate
      ? `clp-addons ${current} is up to date`
      : `clp-addons updated to ${target}; no addon service is configured`);
    return;
  }
  installUnits(specs);
  generateSnapshot();
  ensureDirs(specs);
  startUnits();
  reconcileAnchors(false);
  if (!reconcileNginx(false)) log.warn("Nginx proxy needs manual repair");
  log.ok(upToDate ? `clp-addons ${current} is up to date; provisioning reconciled` : `clp-addons updated to ${target}`);
}

function cmdRepair(argv: string[]): void {
  requireRoot("repair");
  const { positional, flags } = parseFlags(argv);
  const quiet = flags.quiet === true;
  if (flags["anchors-only"] === true) {
    reconcileAnchors(quiet);
    return;
  }
  const specs = positional[0] ? [resolveAddon(positional[0])] : installedAddons();
  if (specs.length === 0) fatal("no addon is installed; run install first");

  const all = installedAddons();
  ensureServiceUser(quiet);
  removeLegacyInstall(quiet);
  ensureDirs(all);
  ensureHmacKey();
  for (const spec of all) {
    writeConfig(spec, true);
    hardenBackups(spec, quiet);
  }
  removeLegacyUnits(quiet);
  removeLegacyUsers(quiet);
  installSudoers(quiet);
  const unitChanged = installUnits(all);
  generateSnapshot();
  ensureDirs(all);
  if (unitChanged || unitActive(MANAGER_UNIT) !== "active") startUnits();
  else ensureTimerArmed("clp-addons-reconcile.timer", quiet);
  reconcileAnchors(quiet);
  if (!reconcileNginx(quiet)) log.err("Nginx proxy is not ready; run repair after checking the master vhost");
  if (!quiet) log.ok(`repair complete (${specs.map((spec) => spec.name).join(", ")})`);
}

function cmdEnsureKey(): void {
  requireRoot("ensure-key");
  ensureHmacKey();
}

function statusValue(value: string, ok: boolean): string {
  if (!process.stdout.isTTY) return value;
  return ok ? `\x1b[32m${value}\x1b[0m` : `\x1b[31m${value}\x1b[0m`;
}

function nginxStatus(status: NginxProxyStatus): string {
  if (status.state === "ok") return statusValue("VHost Injected & Verified ✓", true);
  return statusValue(status.detail ?? "Needs repair", false);
}

function anchorStatus(): string {
  const statuses = installedInjections().map((injection) => inspect(injection));
  if (statuses.length === 0) return "Not configured";
  const required = statuses.filter((status) => {
    const spec = ADDONS[status.addon];
    return spec?.targets.find((target) => target.slug === status.slug)?.required;
  });
  return required.every((status) => status.state === "ok")
    ? statusValue("Twig Templates Patched ✓", true)
    : statusValue("Needs repair", false);
}

function socketStatus(): string {
  if (!existsSync(SOCKET_PATH)) return statusValue(`UNIX Socket (${SOCKET_PATH}) — missing`, false);
  const mode = statSync(SOCKET_PATH).mode & 0o777;
  return mode === 0o660
    ? statusValue(`UNIX Socket (${SOCKET_PATH})`, true)
    : statusValue(`UNIX Socket (${SOCKET_PATH}) — mode ${mode.toString(8)}`, false);
}

async function cmdStatus(): Promise<void> {
  const specs = installedAddons();
  const active = unitActive(MANAGER_UNIT) === "active";
  const pid = unitPid(MANAGER_UNIT);
  const daemon = active ? `● Active${pid ? ` (PID ${pid})` : ""}` : `○ ${unitActive(MANAGER_UNIT)}`;
  const line = "─".repeat(64);

  log.plain(` CloudPanel Addons  v${CLI_VERSION.replace(/^v/, "")}`);
  log.plain(line);
  log.plain(" Status");
  log.plain(`   • Daemon      ${statusValue(daemon, active)}`);
  log.plain(`   • Transport   ${socketStatus()}`);
  log.plain(`   • Nginx       ${nginxStatus(inspectNginxProxy())}`);
  log.plain(`   • Anchors     ${anchorStatus()}`);
  log.plain();
  log.plain(" Installed Addons");
  log.plain("   NAME       ROUTE              WRAPPER       STATE");
  if (specs.length === 0) log.plain("   (none)");
  for (const spec of specs) {
    const wrapper = existsSync(spec.wrapperPath) ? "Verified ✓" : "Missing";
    const state = active && existsSync(spec.wrapperPath) ? "● Ready" : "○ Not ready";
    log.plain(`   ${spec.name.padEnd(10)} ${mountPath(spec.name).padEnd(18)} ${wrapper.padEnd(13)} ${state}`);
  }
  log.plain();
  log.plain(` Dashboard URL: ${dashboardUrl()}`);
  log.plain(line);
}

function listInstances(spec: AddonSpec): string[] {
  if (!existsSync(spec.stateDir)) return [];
  return readdirSync(spec.stateDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(`${spec.stateDir}/${entry.name}/meta.json`))
    .map((entry) => entry.name)
    .sort();
}

function cmdUninstall(argv: string[]): void {
  requireRoot("uninstall");
  const { positional, flags } = parseFlags(argv);
  const spec = resolveAddon(positional[0]);
  if (!installedConfig(spec)) fatal(`${spec.name} is not installed`);
  const purge = flags.purge === true;
  const instances = listInstances(spec);
  const remaining = ADDON_NAMES.filter((name) => name !== spec.name && existsSync(ADDONS[name]!.configFile));

  if (flags.yes !== true) {
    const instanceText = instances.length
      ? instances.map((name) => `  - instance ${name}${purge ? ": container and data" : " (kept)"}`).join("\n")
      : "  - no instances found";
    fatal(
      `uninstall ${spec.name}\n` +
      `  - ${spec.wrapperPath}\n` +
      `  - ${spec.configFile}\n` +
      `  - ${purge ? `${spec.stateDir} and its instances` : `${spec.stateDir} (kept)`}\n` +
      `${instanceText}\n` +
      "Re-run with --yes to proceed.",
    );
  }

  stopUnits(remaining.length > 0);
  removeLegacyInstall();
  removeSudoers();
  reconcileAnchors(true, spec.name);
  purgeTwigCache();
  if (purge) {
    for (const domain of instances) {
      const result = tryRun(spec.wrapperPath, ["delete", "--domain", domain, "--confirm", domain]);
      if (!result.ok) log.warn(`could not remove ${domain}: ${result.out}`);
    }
    rmSync(spec.stateDir, { recursive: true, force: true });
  }
  rmSync(spec.wrapperPath, { force: true });
  rmSync(spec.configFile, { force: true });
  rmSync(`${spec.configFile}.new`, { force: true });

  if (remaining.length > 0) {
    ensureDirs(remaining.map((name) => ADDONS[name]!));
    installSudoers();
    installUnits(remaining.map((name) => ADDONS[name]!));
    startUnits();
    log.ok(`${spec.name} removed; remaining addons are still available`);
    return;
  }

  reconcileNginx(true, false);
  stopUnits();
  removeSudoers();
  rmSync(CLI_BIN, { force: true });
  rmSync(LIBEXEC_DIR, { recursive: true, force: true });
  rmSync(HMAC_KEY_PATH, { force: true });
  log.ok(`${spec.name} removed`);
}

function internalPath(path: string): string {
  if (path === "/addons" || path === "/addons/") return "/";
  if (path.startsWith("/addons/")) return path.slice("/addons".length).replace(/\/+$/, "") || "/";
  return path.replace(/\/+$/, "") || "/";
}

async function cmdServe(): Promise<never> {
  const specs = installedAddons();
  if (specs.length === 0) fatal("no addon is installed; run install first");
  const mounted = specs.map((spec) => spec.name).filter((name) => MANAGERS[name]);
  if (mounted.length === 0) fatal("none of the installed addons have a manager in this binary");

  const socketDir = SOCKET_PATH.slice(0, SOCKET_PATH.lastIndexOf("/"));
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  const server = Bun.serve({
    unix: SOCKET_PATH,
    async fetch(req) {
      const path = internalPath(new URL(req.url).pathname);
      if (path === "/health") {
        return Response.json({ ok: true, service: "clp-addons" }, { headers: SECURITY_HEADERS });
      }

      const gate = await authenticateRequest(req);
      if (gate.response) {
        return new Response(gate.response.body, {
          status: gate.response.status,
          headers: { ...Object.fromEntries(gate.response.headers), ...SECURITY_HEADERS },
        });
      }

      const update = await checkCliUpdate(CLI_VERSION);
      const notice = update?.hasUpdate ? { current: update.current, latest: update.latest } : null;
      const hit = splitMount(path, mounted);
      let response: Response;
      if (hit) response = await MANAGERS[hit.addon]!(req, hit.rest, notice);
      else if (path === "/") response = indexPage(mounted, notice);
      else response = Response.json({ ok: false, error: "not found" }, { status: 404, headers: SECURITY_HEADERS });
      if (gate.auth?.setCookie) response.headers.append("Set-Cookie", gate.auth.setCookie);
      return response;
    },
  });

  chmodSync(SOCKET_PATH, 0o660);
  const groupId = Number.parseInt(execFileSync("getent", ["group", PANEL_GROUP], { encoding: "utf-8" }).split(":")[2] ?? "", 10);
  if (!Number.isInteger(groupId)) throw new Error(`could not resolve group ${PANEL_GROUP}`);
  chownSync(SOCKET_PATH, -1, groupId);
  chmodSync(SOCKET_PATH, 0o660);
  log.plain(`[clp-addons] listening on ${socketDir}/manager.sock`);
  process.on("uncaughtException", (error) => console.error("[clp-addons] uncaught exception:", error));
  process.on("unhandledRejection", (error) => console.error("[clp-addons] unhandled rejection:", error));
  void server;
  return new Promise<never>(() => {});
}

function indexPage(addons: string[], update?: { current: string; latest: string } | null): Response {
  const links = addons.map((name) => `<li><a href="${esc(mountPath(name))}/">${esc(name)}</a></li>`).join("");
  return new Response(renderLayout("CloudPanel Addons", `<div class="card"><ul>${links}</ul></div>`, {
    brand: "CloudPanel Addons",
    base: "/addons",
    nav: [],
    script: "",
    updateNotice: update,
  }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS } });
}

function usage(): void {
  log.plain(`clp-addons ${CLI_VERSION} — CloudPanel Addons

  clp-addons install <addon> [--version=vX.Y.Z] [--skip-attestation]
  clp-addons update [--version=vX.Y.Z] [--skip-attestation]   (alias: upgrade)
  clp-addons repair [<addon>] [--quiet] [--anchors-only]
  clp-addons status
  clp-addons uninstall <addon> --yes [--purge]
  clp-addons serve
  clp-addons --version

Addons: ${ADDON_NAMES.join(", ")}

The manager is served at ${mountPath("instatic").replace("/instatic", "")} through
the CloudPanel master vhost and authenticates with the CloudPanel PHPSESSID.`);
}

async function cmdOverview(): Promise<void> {
  log.plain(`CloudPanel Addons v${CLI_VERSION.replace(/^v/, "")}`);
  log.plain(`Dashboard: ${dashboardUrl()}`);
  const specs = installedAddons();
  log.plain(specs.length ? `Installed: ${specs.map((spec) => spec.name).join(", ")}` : "No addons installed");
  log.plain("Run 'clp-addons status' for service and integration details.");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await cmdOverview();
    return 0;
  }
  const [verb = "help", ...rest] = args;
  switch (verb) {
    case "overview": await cmdOverview(); return 0;
    case "--version":
    case "-v": log.plain(CLI_VERSION); return 0;
    case "install": await cmdInstall(rest); return 0;
    case "update":
    case "upgrade": await cmdUpdate(rest); return 0;
    case "self-update": fatal("self-update is deprecated; use clp-addons update");
    case "ensure-key": cmdEnsureKey(); return 0;
    case "repair": cmdRepair(rest); return 0;
    case "status": await cmdStatus(); return 0;
    case "uninstall": cmdUninstall(rest); return 0;
    case "serve": return await cmdServe();
    case "help":
    case "--help":
    case "-h": usage(); return 0;
    default: log.err(`unknown command '${verb}'`); usage(); return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    if (error instanceof Fatal) {
      log.err(error.message);
      process.exit(1);
    }
    throw error;
  }
}
