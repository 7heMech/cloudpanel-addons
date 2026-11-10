// The Setup checklist, as root reads it: each enabled addon's steps checked
// against the server, a disabled addon's steps offered with Enable, and what
// each administrator skipped or hid.
import { readFileSync } from "node:fs";
import { ADDONS, ADDON_NAMES, addonEnabled } from "../addons/catalog";
import { SETUP_LEVELS, type SetupCheck, type SetupLevel, type SetupStep } from "../lib/addon-definition";
import { writeFileAtomic } from "../lib/atomic-write";
import { errorMessage } from "../lib/errors";
import { withFileLockSync } from "../lib/file-lock";
import { withPanelDb } from "../lib/panel-db";
import { addonStateDir, PANEL_DB } from "../lib/paths";

const PREFS_FILE = `${addonStateDir("manager")}/setup.json`;

export interface SetupItem {
  id: string;
  level: SetupLevel;
  title: string;
  href: string;
  /** The addon the step belongs to, offered with Enable while it is off and the step not done; null for one about CloudPanel itself. */
  addon: { name: string; title: string; enabled: boolean } | null;
  state: SetupCheck["state"] | "skipped";
  reason: string;
}

export interface SetupView {
  hidden: boolean;
  steps: SetupItem[];
}

interface UserPrefs { hidden?: true; skipped?: string[] }
type Prefs = Record<string, UserPrefs>;

/** CloudPanel's own Remote Backups, which no addon sets up. */
export function remoteBackupsCheck(config: Record<string, string>): SetupCheck {
  const enabled = ["1", "true"].includes((config.remote_backup_enabled ?? "").trim().toLowerCase());
  const provider = (config.remote_backup_storage_provider ?? "").trim();
  if (enabled && provider) return { state: "done", reason: `On, to ${provider}` };
  return { state: "todo", reason: provider ? "Set up but switched off" : "Sites are backed up on this server only" };
}

function panelConfig(panelDb: string): Record<string, string> {
  return withPanelDb(panelDb, (db) => Object.fromEntries(
    db.query<{ key: string; value: unknown }, []>("SELECT key, value FROM config WHERE key LIKE 'remote_backup_%'").all()
      .map((row) => [row.key, String(row.value ?? "")]),
  ));
}

export const CORE_SETUP: SetupStep[] = [
  {
    id: "remote-backups",
    level: "sites",
    title: "Remote backups",
    href: "/admin/remote-backup",
    check: (options) => remoteBackupsCheck(panelConfig(String(options?.panelDb ?? PANEL_DB))),
  },
];

async function checked(step: SetupStep, options: Record<string, unknown>): Promise<SetupCheck> {
  try {
    return await step.check(options);
  } catch (error) {
    return { state: "todo", reason: `Could not be checked: ${errorMessage(error)}` };
  }
}

interface SetupSource {
  /** Each addon's steps, in catalog order, and whether it is on. */
  addons: { name: string; title: string; enabled: boolean; steps: SetupStep[] }[];
  core: SetupStep[];
}

function catalogSource(): SetupSource {
  return {
    addons: ADDON_NAMES.flatMap((name) => {
      const spec = ADDONS[name]!;
      return spec.setup?.length ? [{ name, title: spec.title, enabled: addonEnabled(spec), steps: spec.setup }] : [];
    }),
    core: CORE_SETUP,
  };
}

/** Every step, by level: CloudPanel's own first, then the addons' in catalog order. */
export async function setupSteps(
  prefs: UserPrefs,
  source: SetupSource = catalogSource(),
  options: Record<string, unknown> = {},
): Promise<SetupItem[]> {
  const skipped = new Set(prefs.skipped ?? []);
  const entries = [
    ...source.core.map((step) => ({ step, addon: null })),
    ...source.addons.flatMap((addon) => addon.steps.map((step) => ({ step, addon }))),
  ];
  const items = await Promise.all(entries.map(async ({ step, addon }): Promise<SetupItem> => {
    const off: SetupCheck | null = addon && !addon.enabled ? { state: "todo", reason: `${addon.title} is off` } : null;
    const found = off && !step.whileOff ? off : await checked(step, options);
    const result = off && found.state === "todo" ? off : found;
    return {
      id: step.id, level: step.level, title: step.title, href: step.href,
      addon: addon && { name: addon.name, title: addon.title, enabled: addon.enabled },
      state: result.state === "todo" && skipped.has(step.id) ? "skipped" : result.state,
      reason: result.reason,
    };
  }));
  const order = Object.keys(SETUP_LEVELS);
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => order.indexOf(a.item.level) - order.indexOf(b.item.level) || a.index - b.index)
    .map(({ item }) => item);
}

export function readSetupPrefs(file = PREFS_FILE): Prefs {
  try {
    const stored: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Prefs : {};
  } catch {
    return {};
  }
}

export async function setupView(user: string, file = PREFS_FILE, source?: SetupSource, options?: Record<string, unknown>): Promise<SetupView> {
  const prefs = readSetupPrefs(file)[user] ?? {};
  return { hidden: prefs.hidden === true, steps: await setupSteps(prefs, source, options) };
}

export type SetupChange = { skip: string } | { unskip: string } | { hidden: boolean };

export function changeSetupPrefs(user: string, change: SetupChange, file = PREFS_FILE): void {
  withFileLockSync(`${file}.lock`, 5, "another Setup change is being saved", () => {
    const prefs = readSetupPrefs(file);
    const mine: UserPrefs = { ...prefs[user] };
    const skipped = new Set(mine.skipped ?? []);
    if ("skip" in change) skipped.add(change.skip);
    else if ("unskip" in change) skipped.delete(change.unskip);
    else if (change.hidden) mine.hidden = true;
    else delete mine.hidden;
    if (skipped.size) mine.skipped = [...skipped].sort();
    else delete mine.skipped;
    if (Object.keys(mine).length) prefs[user] = mine;
    else delete prefs[user];
    writeFileAtomic(file, `${JSON.stringify(prefs)}\n`, { mode: 0o600, createParent: true });
  });
}

/** Every step id an addon or CloudPanel declares, so a skip names a real one. */
export function setupStepIds(source: SetupSource = catalogSource()): string[] {
  return [...source.core, ...source.addons.flatMap((addon) => addon.steps)].map((step) => step.id);
}
