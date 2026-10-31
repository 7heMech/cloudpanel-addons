// The long-lived process behind `clp-addons serve`: one Unix socket, one
// request gate, and every addon mounted behind it.
import type { Server } from "bun";
import { chmodSync, chownSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { ADDONS, ADDON_NAMES, addonHandler } from "../cli/addon-catalog";
import { MANAGER_UNIT, PANEL_GROUP, SERVICE_USER, SOCKET_PATH } from "../cli/paths";
import { CLI_VERSION } from "../cli/release";
import { fatal, log } from "../cli/util";
import { jsonResponse, newCsrfToken } from "../lib/app-http";
import { gatewayCaller } from "../lib/gateway-client";
import { splitMount } from "../lib/mount";
import { adminGate, authenticateRequest } from "../lib/sso-auth";
import { checkCliUpdate } from "../lib/update-check";
import { handleManagerRoute } from "./index";
import { latestManagerJobView, seenNews } from "./service";
import { indexPage, updatePage } from "./views";

function internalPath(path: string): string {
  if (path === "/addons" || path === "/addons/") return "/";
  if (path.startsWith("/addons/")) return path.slice("/addons".length).replace(/\/+$/, "") || "/";
  return path.replace(/\/+$/, "") || "/";
}

/**
 * Which addons this manager serves, answered per request.
 *
 * This used to be a list built once at startup, which is why enabling an addon
 * had to restart the manager: until it did, the addon's own pages returned 404
 * from a process that had been told, at boot, that it did not exist. The handler
 * map is still compiled in and still explicit -- nothing is loaded dynamically.
 * What is dynamic is availability, and availability is a config file, so it is
 * read from the config files.
 *
 * Serving nothing is a legitimate state, not a failed start. Every addon is
 * compiled in, so a manager with none of them enabled still has a job: it is
 * the page that offers them back. Exiting instead meant disabling the last
 * addon killed the only surface that could re-enable it.
 */
function mountedAddons(): string[] {
  return ADDON_NAMES.filter((name) => addonHandler(name) && existsSync(ADDONS[name]!.configFile));
}

/**
 * Every request the manager answers, in the order it decides them. Exported so
 * a test can send real requests through the same function the socket does.
 */
export async function handleRequest(req: Request, server: Server<unknown>): Promise<Response> {
  const path = internalPath(new URL(req.url).pathname);

  // An addon's route before the gate answers on a credential root checks, such
  // as a push-to-deploy token or a passkey's signature, and returns null for
  // anything else, which then meets the gate like any other request. Nothing
  // is looked up for a request outside its prefix.
  for (const name of ADDON_NAMES) {
    const preGate = ADDONS[name]!.preGate;
    if (!preGate || !path.startsWith(preGate.prefix) || !mountedAddons().includes(name)) continue;
    const answer = await gatewayCaller.run({ roles: null }, () => preGate.handle(req, path));
    if (answer) return answer;
  }

  // Nothing else is answered before this, not even the liveness probe: a route
  // decided ahead of the gate answers whoever can reach the panel.
  const gate = await authenticateRequest(req);
  // Sent as the gate built it. The shared header policy used to go over the
  // top, which is what made a refusal here look unlike the panel's own.
  if (gate.response) return gate.response;

  // The manager is an administrative surface. Keep this decision at the
  // shared socket boundary so every mounted HTML and API route, including
  // future handlers and the manager index, receives the same gate before
  // update checks or addon code can run. The exceptions: a signed-in
  // non-administrator reaches an addon's self-scoped routes, and a site
  // manager all of an addon that declares `siteManager`. Straight to the addon,
  // ahead of the update check and the manager's own routes, and only to the
  // verbs declared for them.
  const denied = adminGate(gate.auth);
  if (denied) {
    const name = path.split("/")[1] ?? "";
    const addon = Object.hasOwn(ADDONS, name) ? ADDONS[name]! : null;
    const selfScoped = addon?.selfScopedRoutes?.includes(`${req.method} ${path.slice(name.length + 1) || "/"}`) ?? false;
    const siteManager = addon?.siteManager === true && (gate.auth?.roles.includes("ROLE_SITE_MANAGER") ?? false);
    if (!selfScoped && !siteManager) return denied;
    const scoped = splitMount(path, mountedAddons());
    if (!scoped) return denied;
    return await gatewayCaller.run(
      { roles: gate.auth?.roles ?? [] },
      () => addonHandler(scoped.addon)!(req, scoped.rest, null, server, gate.auth),
    );
  }

  // Polled while this process restarts; the gateway that validates the session
  // is a separate unit, so it keeps answering across the restart.
  if (path === "/health") {
    return jsonResponse({ ok: true, service: "clp-addons" });
  }

  const update = await checkCliUpdate(CLI_VERSION);
  const notice = update?.hasUpdate ? { current: update.current, latest: update.latest } : null;

  const managerRoute = await handleManagerRoute(req, path, server, update);
  if (managerRoute) return managerRoute;

  const hit = splitMount(path, mountedAddons());
  if (hit) return await addonHandler(hit.addon)!(req, hit.rest, notice, server, gate.auth);
  if (path === "/update" && req.method === "GET") {
    return updatePage(update, CLI_VERSION, { job: await latestManagerJobView(), csrf: newCsrfToken() });
  }
  if (path === "/") {
    // Read at request time rather than from the startup addon list: a job
    // that has just finished enabling an addon has not yet restarted this
    // process, and a page that still denied the addon existed would be
    // wrong for exactly as long as anybody was likely to look at it.
    const enabled = ADDON_NAMES.filter((name) => existsSync(ADDONS[name]!.configFile));
    const [job, news] = await Promise.all([latestManagerJobView(), seenNews()]);
    return indexPage(enabled, notice, {
      available: ADDON_NAMES.filter((name) => !enabled.includes(name)),
      job,
      ...news,
      csrf: newCsrfToken(),
    });
  }
  return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
}

/**
 * Starts the manager on its Unix socket and remains pending for the process
 * lifetime. The restrictive socket-creation umask is restored before setup
 * continues or an error escapes.
 */
export async function cmdServe(): Promise<never> {
  // Anything else replaces the live daemon's socket with one the auth gateway
  // will not answer for, which takes every addon page down until a restart.
  // The unit's cgroup is set by systemd, where an environment variable is not.
  const cgroups = readFileSync("/proc/self/cgroup", "utf-8").split("\n");
  const inUnit = cgroups.some((line) => line.endsWith(`/${MANAGER_UNIT}`));
  if (!inUnit || userInfo().username !== SERVICE_USER) {
    fatal(`'serve' runs only as the ${MANAGER_UNIT} unit; to restart the manager: systemctl restart ${MANAGER_UNIT}`);
  }
  const socketDir = SOCKET_PATH.slice(0, SOCKET_PATH.lastIndexOf("/"));
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  const prevUmask = process.umask(0o007);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: SOCKET_PATH,
      // Bun renders its own error page, stack trace included, unless NODE_ENV
      // is production, and the unit sets no NODE_ENV.
      development: false,
      // Bun's 10-second default drops a request whose gateway call takes
      // longer; Nginx and each call's own deadline bound the wait instead.
      // Its types offer idleTimeout to TCP servers only, and per-request
      // server.timeout() does not reach a Unix socket, but this does.
      ...({ idleTimeout: 0 } as object),
      error(error) {
        console.error("[clp-addons] request failed:", error);
        return jsonResponse({ ok: false, error: "internal error" }, { status: 500 });
      },
      fetch: handleRequest,
    });
  } finally {
    process.umask(prevUmask);
  }

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
