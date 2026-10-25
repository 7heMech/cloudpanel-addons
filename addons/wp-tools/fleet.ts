// Per-site bookkeeping that the Varnish and MainWP policies share.

export interface FleetState<T> {
  excluded: string[];
  sites: Record<string, T>;
}

/** Forgets domains the panel no longer has, so a recreated site starts fresh. Returns what it dropped. */
export function pruneFleet<T>(state: FleetState<T>, domains: Set<string>): Record<string, T> {
  const dropped: Record<string, T> = {};
  // A panel that lists no site at all is far likelier a bad read than every
  // site deleted at once, so nothing is forgotten on it.
  if (domains.size === 0) return dropped;
  state.excluded = state.excluded.filter((domain) => domains.has(domain));
  for (const [domain, record] of Object.entries(state.sites)) {
    if (domains.has(domain)) continue;
    dropped[domain] = record;
    delete state.sites[domain];
  }
  return dropped;
}

/**
 * Least recently checked first. A pass is bounded even when one site's PHP or
 * a download stalls, and the next one carries on from the sites it left.
 */
export function leastRecentlyChecked<S extends { domain: string }>(
  sites: S[],
  records: Record<string, { checkedAt: string } | undefined>,
): S[] {
  return [...sites].sort((a, b) => (records[a.domain]?.checkedAt ?? "").localeCompare(records[b.domain]?.checkedAt ?? ""));
}
