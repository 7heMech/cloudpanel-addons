// Searching the WordPress.org plugin directory for the new-site form.
//
// Asked from the manager rather than as root: it is a public, read-only API,
// and the reply only ever becomes text on the administrator's page. It is still
// cut down to the few fields the form shows, each checked and bounded, so a
// directory that answered something odd cannot put markup or a slug that would
// later be refused in front of anyone.

import { readBoundedText } from "../../../lib/app-http";
import { decodeEntities, type Fetch } from "../new-site-plugins";
import { DIRECTORY_SLUG_RE, cleanLabel } from "../plugin-zip";

const DIRECTORY_API = "https://api.wordpress.org/plugins/info/1.2/";
const RESULTS = 12;

export interface DirectoryPlugin {
  slug: string;
  name: string;
  version: string;
  author: string;
  activeInstalls: number;
  summary: string;
}

/** What the form may search for: some words, without anything that is not text. */
export function searchTerm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const term = cleanLabel(value).slice(0, 100);
  return term.length >= 2 ? term : null;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? cleanLabel(decodeEntities(value.replace(/<[^>]*>/g, ""))).slice(0, max) : "";
}

export async function searchDirectory(term: string, fetchImpl: Fetch = fetch): Promise<DirectoryPlugin[]> {
  const query = new URLSearchParams({
    action: "query_plugins", "request[search]": term, "request[per_page]": String(RESULTS),
    "request[fields][description]": "0", "request[fields][sections]": "0", "request[fields][icons]": "0",
    "request[fields][banners]": "0", "request[fields][ratings]": "0", "request[fields][tags]": "0",
    "request[fields][versions]": "0", "request[fields][screenshots]": "0", "request[fields][contributors]": "0",
  });
  let reply: { plugins?: unknown };
  try {
    const response = await fetchImpl(`${DIRECTORY_API}?${query}`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    reply = JSON.parse(await readBoundedText(response, 2 * 1024 * 1024));
  } catch (error) {
    throw new Error(`WordPress.org did not answer the search: ${error instanceof Error ? error.message : String(error)}`);
  }
  const plugins = Array.isArray(reply?.plugins) ? reply.plugins as Record<string, unknown>[] : [];
  return plugins.flatMap((plugin) => {
    if (!plugin || typeof plugin.slug !== "string" || !DIRECTORY_SLUG_RE.test(plugin.slug)) return [];
    const installs = Number(plugin.active_installs);
    return [{
      slug: plugin.slug,
      name: text(plugin.name, 120) || plugin.slug,
      version: text(plugin.version, 40),
      author: text(plugin.author, 80),
      activeInstalls: Number.isSafeInteger(installs) && installs > 0 ? installs : 0,
      summary: text(plugin.short_description, 160),
    }];
  }).slice(0, RESULTS);
}
