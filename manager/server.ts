// The long-lived process behind `clp-addons serve`: one Unix socket, one
// request gate, and every addon mounted behind it.
import type { Server } from "bun";
import { chmodSync, chownSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ADDONS, ADDON_NAMES, addonHandler } from "../cli/addon-catalog";
import { PANEL_GROUP, SOCKET_PATH } from "../cli/paths";
import { CLI_VERSION } from "../cli/release";
import { log } from "../cli/util";
import { jsonResponse, newCsrfToken } from "../lib/app-http";
import { splitMount } from "../lib/mount";
import { adminGate, authenticateRequest } from "../lib/sso-auth";
import { checkCliUpdate } from "../lib/update-check";
import { GIT_HOOK_PREFIX, handleGitHook } from "../addons/git/app/hook";
import { handleManagerRoute } from "./index";
import { latestManagerJobView } from "./service";
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
 * The routes a signed-in non-administrator may reach, named one by one.
 *
 * An addon that declares `siteManager` is the other way in, for the whole
 * mount rather than a route: CloudPanel does not narrow a site manager's site
 * list, so its pages are already scoped for that role.
 *
 * The blanket gate below is what makes the manager an administrative surface,
 * and these are the exceptions that scope themselves instead. The WordPress
 * sign-in is one because the panel user it signs in for is one CloudPanel
 * already gave the site's file manager and database to, so the shortcut adds
 * no authority; the root action holds it to the sites `user_sites` maps to
 * that account. The session route hands out the CSRF pair those callers cannot
 * get from an addon page, and reads nothing. Panel Tweaks' state route is one
 * because the page it enhances is CloudPanel's own Sites page, which every
 * panel user sees; the action narrows the reply to the rows that page would
 * already have drawn for the caller.
 */
const SELF_SCOPED_ROUTES = new Set([
  "POST /wp-login/api/sign-in",
  "GET /wp-login/api/session",
  "GET /panel-tweaks/api/panel",
]);

/**
 * Every request the manager answers, in the order it decides them. Exported so
 * a test can send real requests through the same function the socket does.
 */
export async function handleRequest(req: Request, server: Server<unknown>): Promise<Response> {
  const path = internalPath(new URL(req.url).pathname);

  // The one credential that is not a CloudPanel session. A POST whose URL
  // carries a per-site token the root gateway recognises is a push-to-deploy
  // delivery and is answered here; anything else returns null and meets the
  // gate below, so this is a second credential type rather than an exception
  // list, and the URL is no oracle for which sites have a webhook.
  // Nothing is looked up for a request that is not shaped like one: the gate
  // below stays the first thing every other request meets.
  if (req.method === "POST" && path.startsWith(GIT_HOOK_PREFIX) && mountedAddons().includes("git")) {
    const delivery = await handleGitHook(req, path);
    if (delivery) return delivery;
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
  // update checks or addon code can run.
  const denied = adminGate(gate.auth);
  if (denied) {
    const selfScoped = SELF_SCOPED_ROUTES.has(`${req.method} ${path}`);
    const siteManager = gate.auth?.roles.includes("ROLE_SITE_MANAGER") ?? false;
    if (!selfScoped && !siteManager) return denied;
    // Straight to the addon, ahead of the update check and the manager's own
    // routes: what this session is allowed is that handler, not the rest of
    // the manager with a narrower path.
    const scoped = splitMount(path, mountedAddons());
    if (!scoped) return denied;
    if (!selfScoped && ADDONS[scoped.addon]?.siteManager !== true) return denied;
    return await addonHandler(scoped.addon)!(req, scoped.rest, null, server, gate.auth);
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
    return indexPage(enabled, notice, {
      available: ADDON_NAMES.filter((name) => !enabled.includes(name)),
      job: await latestManagerJobView(),
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
