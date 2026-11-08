// The Theme & Branding logos, for the header and favicon the addon pages draw
// themselves. CloudPanel's own pages have them baked into their templates;
// these pages ask root, at most once a minute, and the Panel Tweaks page
// forgets the answer when it changes the setting.

import { callGatewayAction } from "./gateway-client";
import { mountPath } from "./mount";

/** Image URLs, light then dark; each falls back to the other, as on CloudPanel's pages. */
export interface PanelLogos {
  header: [string, string] | null;
  mark: [string, string] | null;
  favicon: string;
}

type Slots = { headerLight: string; headerDark: string; markLight: string; markDark: string; favicon: string };

const TTL_MS = 60_000;
let cached: { at: number; logos: PanelLogos | null } | null = null;
let refreshing: Promise<void> | null = null;
let generation = 0;

export function panelLogos(): PanelLogos | null {
  return cached?.logos ?? null;
}

export function forgetPanelLogos(): void {
  cached = null;
  generation++;
}

export function logosFromSlots(slots: Slots | null): PanelLogos | null {
  if (!slots) return null;
  const url = (name: string) => name ? `${mountPath("panel-tweaks")}/branding/${encodeURIComponent(name)}` : "";
  const pair = (light: string, dark: string): [string, string] | null =>
    light || dark ? [url(light || dark), url(dark || light)] : null;
  const logos = {
    header: pair(slots.headerLight, slots.headerDark),
    mark: pair(slots.markLight, slots.markDark),
    favicon: url(slots.favicon),
  };
  return logos.header || logos.mark || logos.favicon ? logos : null;
}

export async function refreshPanelLogos(enabled: boolean): Promise<void> {
  if (!enabled) {
    forgetPanelLogos();
    return;
  }
  if (cached && Date.now() - cached.at < TTL_MS) return;
  refreshing ??= (async () => {
    const started = generation;
    let logos: PanelLogos | null = null;
    try {
      const result = await callGatewayAction("panel-tweaks", "branding-logos", [], undefined, { timeout: 5_000 });
      if (result.ok) logos = logosFromSlots((result.data as unknown as Slots | undefined) ?? null);
    } catch {
      // CloudPanel's own logo until the next try.
    }
    if (started === generation) cached = { at: Date.now(), logos };
  })().finally(() => { refreshing = null; });
  await refreshing;
}
