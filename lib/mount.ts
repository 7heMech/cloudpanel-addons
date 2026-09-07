// Where each addon's manager is mounted under the shared hostname.
//
// One CloudPanel site serves every addon, so the path is what tells them apart.
// It lives here rather than in cli/paths.ts because both sides need it: the CLI
// builds the panel's nav URLs from it, and each addon's views build their own
// links from it. An addon importing cli/paths.ts to find out where it is served
// would be the app depending on the installer.
//
// Derived from the addon's name rather than declared per addon. A second
// spelling is a second thing to keep in step, and the failure -- a nav entry
// pointing at a path nothing serves -- is a 404 with no explanation on it.

export function mountPath(addon: string): string {
  return `/${addon}`;
}

/**
 * Split a request path into the addon it addresses and the rest.
 *
 * `/instatic/api/instances` is instatic's `/api/instances`; `/instatic` and
 * `/instatic/` are both its `/`. A path that names no installed addon returns
 * null, which the router answers itself rather than guessing at an addon.
 */
export function splitMount(path: string, addons: string[]): { addon: string; rest: string } | null {
  for (const addon of addons) {
    const base = mountPath(addon);
    if (path === base) return { addon, rest: "/" };
    if (path.startsWith(`${base}/`)) {
      const rest = path.slice(base.length).replace(/\/+$/, "") || "/";
      return { addon, rest };
    }
  }
  return null;
}
