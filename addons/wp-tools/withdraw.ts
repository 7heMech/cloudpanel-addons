import { withFileLockSync } from "../../lib/file-lock";
import { errorMessage } from "../../lib/errors";
import { log } from "../../lib/log";
import { DEFAULT_WP_TOOLS_PATHS, removeMainwpGuards, removeWpLogin } from "./action";
import { requireMainwpSettled } from "./mainwp";

/**
 * Disabling WordPress Tools, under every lock its own changes take, so none is
 * part-way through a site while the addon leaves it.
 *
 * The sign-in helper and the MainWP guard are files in somebody else's site,
 * not state in this addon's own directory, so they come out of every site;
 * then the config goes under the sign-in lock, and a sign-in waiting on that
 * lock finds the addon gone rather than putting a helper back. A site whose
 * files cannot be cleaned warns rather than stops: an addon that cannot be
 * removed because one site's files moved would be worse than a helper left
 * behind and named.
 */
export function withdrawWpTools(removeConfig: () => void): void {
  const paths = DEFAULT_WP_TOOLS_PATHS;
  withFileLockSync(paths.mainwpLockFile, 15, "a MainWP change is still running", () => {
    requireMainwpSettled(paths.mainwpState);
    withFileLockSync(paths.varnishLockFile, 15, "a WordPress Varnish change is still running", () =>
      withFileLockSync(paths.lockFile, 30, "a WordPress sign-in is still running", () => {
        try {
          const { removed, failed } = removeWpLogin();
          if (removed > 0) log.ok(`sign-in helper removed from ${removed} site${removed === 1 ? "" : "s"}`);
          if (failed.length > 0) log.warn(`the sign-in helper is still in ${failed.join("; ")}`);
        } catch (error) {
          log.warn(`the sign-in helper could not be removed from every site: ${errorMessage(error)}`);
        }
        try {
          const { removed, failed } = removeMainwpGuards();
          if (removed > 0) log.ok(`MainWP guard removed from ${removed} site${removed === 1 ? "" : "s"}`);
          if (failed.length > 0) log.warn(`the MainWP guard is still in ${failed.join("; ")}`);
        } catch (error) {
          log.warn(`the MainWP guard could not be removed from every site: ${errorMessage(error)}`);
        }
        removeConfig();
      }));
  });
}
