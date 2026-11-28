// The addon actions opted-in usage counts, by addon. The server counts only
// these and the clp.7he.dev Worker accepts only these (`bun run site` writes
// them for it), so no other text can ever be counted or sent.
import { ADDON_VERBS } from "./gateway-protocol";

/** Job polling repeats while a page is open; it says nothing about use. */
const UNCOUNTED = new Set(["job", "jobs"]);

export function countedActions(): Record<string, string[]> {
  const actions: Record<string, string[]> = {};
  for (const [addon, verbs] of Object.entries(ADDON_VERBS)) {
    if (addon === "manager") continue;
    const names = Object.entries(verbs as Record<string, { web: unknown; stream?: unknown }>)
      .filter(([verb, declared]) => declared.web !== false && !declared.stream && !UNCOUNTED.has(verb))
      .map(([verb]) => verb)
      .sort();
    if (names.length) actions[addon] = names;
  }
  return actions;
}
