// The one must-use plugin WordPress Tools puts in a site: a loader, listed as
// Hosting Tools, that includes each module present in its folder. WordPress
// lists and loads only the PHP files directly inside mu-plugins. Paths are
// relative to the site's root.
import LOADER from "./hosting-tools.php" with { type: "text" };

export const HOSTING_TOOLS_LOADER_PHP: string = LOADER;

const MU_PLUGINS = "wp-content/mu-plugins";
export const LOADER_FILE = `${MU_PLUGINS}/hosting-tools.php`;
export const MODULE_DIR = `${MU_PLUGINS}/hosting-tools`;
export const SIGN_IN_FILE = `${MODULE_DIR}/sign-in.php`;
export const SECRET_FILE = `${MODULE_DIR}/token.php`;
export const GUARD_FILE = `${MODULE_DIR}/guard.php`;

/** The separate must-use plugins earlier releases wrote; each module cleans up its own, and writing the guard cleans up both. */
export const LEGACY_SIGN_IN_LOADER = `${MU_PLUGINS}/clp-addons-login.php`;
export const LEGACY_SIGN_IN = [LEGACY_SIGN_IN_LOADER, `${MU_PLUGINS}/clp-addons`];
export const LEGACY_GUARD = `${MU_PLUGINS}/clp-addons-mainwp.php`;
