// Who besides administrators may choose plugins on CloudPanel's New WordPress
// Site form: site managers, from the WordPress.org directory only.
//
// Off by default. Site managers already create sites on that form, so letting
// them pick plugins there gives them nothing of the Addons area. An uploaded zip
// is code nobody has reviewed, so uploading stays an administrator's whatever
// this says. It is markup in CloudPanel's templates, read when they are
// rendered, so changing it renders them again.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";

export interface WpNewSiteAccess {
  siteManagers: boolean;
}

export const DEFAULT_NEW_SITE_ACCESS: WpNewSiteAccess = { siteManagers: false };

export function readNewSiteAccess(path: string): WpNewSiteAccess {
  if (!existsSync(path)) return { ...DEFAULT_NEW_SITE_ACCESS };
  const state = JSON.parse(readFileSync(path, "utf8")) as Partial<WpNewSiteAccess>;
  if (typeof state.siteManagers !== "boolean") throw new Error("the new-site plugins setting is invalid");
  return { siteManagers: state.siteManagers };
}

export function saveNewSiteAccess(path: string, state: WpNewSiteAccess): void {
  writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600, createParent: true });
}
