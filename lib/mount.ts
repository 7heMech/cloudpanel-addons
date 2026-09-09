export const ADDONS_BASE_PATH = "/addons";

export function mountPath(addon: string): string {
  return `${ADDONS_BASE_PATH}/${addon}`;
}

export function splitMount(path: string, addons: string[]): { addon: string; rest: string } | null {
  for (const addon of addons) {
    for (const base of [mountPath(addon), `/${addon}`]) {
      if (path === base || path === `${base}/`) return { addon, rest: "/" };
      if (path.startsWith(`${base}/`)) {
        const rest = path.slice(base.length).replace(/\/+$/, "") || "/";
        return { addon, rest };
      }
    }
  }
  return null;
}
