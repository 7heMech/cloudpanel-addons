// Whether the domain at the top of a WordPress site's pages in CloudPanel signs
// in to WordPress rather than opening the site.
//
// On by default: the panel already links the site from its Sites page and the
// address bar is one click away, while a way into wp-admin is what an operator
// on a site's pages is usually after. It is markup in a CloudPanel template,
// read when the templates are rendered, so changing it renders them again.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";

export interface WpDomainLink {
  signIn: boolean;
}

export const DEFAULT_DOMAIN_LINK: WpDomainLink = { signIn: true };

export function readDomainLink(path: string): WpDomainLink {
  if (!existsSync(path)) return { ...DEFAULT_DOMAIN_LINK };
  const state = JSON.parse(readFileSync(path, "utf8")) as Partial<WpDomainLink>;
  if (typeof state.signIn !== "boolean") throw new Error("the WordPress domain link setting is invalid");
  return { signIn: state.signIn };
}

export function saveDomainLink(path: string, state: WpDomainLink): void {
  writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600, createParent: true });
}
