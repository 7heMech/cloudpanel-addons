// Every System Tweaks tweak, and the order each phase runs them in. The orders
// differ on purpose and are written out, not derived: see the comment on each.
import { clearAbandonedTmpFiles, type TmpCleanupOptions } from "../../lib/tmp-cleanup";
import { BACKUP_COMPRESSION_TWEAK } from "./backup-compression";
import { CLPCTL_GUARD_TWEAK } from "./clpctl-guard";
import { DATABASE_TWEAK } from "./database";
import { FILE_MANAGER_GUARD_TWEAK } from "./file-manager-guard";
import { FIREWALL_TWEAK } from "./firewall";
import { LOGIN_JAILS_TWEAK } from "./login-jails";
import { MOTD_TWEAK } from "./motd";
import { PANEL_CERT_TWEAK } from "./panel-cert";
import { PANEL_PHP_TWEAK } from "./panel-php";
import { PHPMYADMIN_TWEAK } from "./phpmyadmin";
import { PHP_POOLS_TWEAK } from "./pool-isolation";
import { REAL_IP_TWEAK } from "./real-ip";
import { TELEMETRY_TWEAK } from "./telemetry";
import type { RepairStep, RestoreStep, TweakContext, WithdrawStep } from "./tweak";
import { UPDATES_TWEAK } from "./updates";
import { UPLOAD_GUARD_TWEAK } from "./upload-progress";
import { VHOST_GUARD_TWEAK } from "./vhost-guard";

/** Every tweak, in the order settings.json keeps their settings. */
export const TWEAKS = [
  UPDATES_TWEAK, UPLOAD_GUARD_TWEAK, REAL_IP_TWEAK, VHOST_GUARD_TWEAK, PHP_POOLS_TWEAK, PHPMYADMIN_TWEAK, FILE_MANAGER_GUARD_TWEAK,
  PANEL_CERT_TWEAK, LOGIN_JAILS_TWEAK, DATABASE_TWEAK, CLPCTL_GUARD_TWEAK, TELEMETRY_TWEAK, MOTD_TWEAK, BACKUP_COMPRESSION_TWEAK,
  PANEL_PHP_TWEAK, FIREWALL_TWEAK,
] as const;

type Flat<T> = { [K in keyof T]: T[K] };
type Intersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;
type Declared = NonNullable<(typeof TWEAKS)[number]["types"]>;

export type SystemTweaksSettings = Flat<Intersection<Declared["settings"]>>;
export type SystemTweaksState = Flat<Intersection<Declared["state"]>>;
/** What the tweaks read from the action's options, each tweak module's own options under its own name. */
export type TweakOptions = Flat<Intersection<Declared["options"]> & { tmpCleanup?: TmpCleanupOptions }>;

type Context = TweakContext<SystemTweaksSettings, TweakOptions>;
type Tweak = (typeof TWEAKS)[number];

/** The parts of `state`, in the order it reads and names them. */
export const STATE: readonly Tweak[] = [
  UPDATES_TWEAK, UPLOAD_GUARD_TWEAK, REAL_IP_TWEAK, PHPMYADMIN_TWEAK, PANEL_CERT_TWEAK, VHOST_GUARD_TWEAK, PHP_POOLS_TWEAK,
  FILE_MANAGER_GUARD_TWEAK, CLPCTL_GUARD_TWEAK, PANEL_PHP_TWEAK, FIREWALL_TWEAK, LOGIN_JAILS_TWEAK, DATABASE_TWEAK,
  BACKUP_COMPRESSION_TWEAK, TELEMETRY_TWEAK, MOTD_TWEAK,
];

/** The Hardening card's rows, in the page's order; the other cards are the page's own. */
export const HARDENING = [
  PANEL_PHP_TWEAK, UPLOAD_GUARD_TWEAK, REAL_IP_TWEAK, PHPMYADMIN_TWEAK, DATABASE_TWEAK, PANEL_CERT_TWEAK, VHOST_GUARD_TWEAK,
  PHP_POOLS_TWEAK, FILE_MANAGER_GUARD_TWEAK, CLPCTL_GUARD_TWEAK, TELEMETRY_TWEAK,
] as const;

const UPKEEP_STEPS = [UPDATES_TWEAK.repair.upkeep, REAL_IP_TWEAK.repair.upkeep, LOGIN_JAILS_TWEAK.repair.upkeep, DATABASE_TWEAK.repair.upkeep];

/** The quick reconciliations, under one lock: a failure stops the ones after it and is reported as it is. */
export const UPKEEP = {
  label: null,
  locked: true,
  run: (ctx: Context) => UPKEEP_STEPS.map((step) => step.run(ctx)).filter(Boolean).join("; ") || null,
} satisfies RepairStep<SystemTweaksSettings, TweakOptions>;

const TMP_CLEANUP: RepairStep<{}, { tmpCleanup?: TmpCleanupOptions }> = {
  label: "/tmp cleanup",
  locked: false,
  run: ({ options }) => clearAbandonedTmpFiles(options.tmpCleanup),
};

/**
 * Repair, every step in this order whatever the others do. Each reports a line
 * when it changed something, and a failure as `<label>: <error>`.
 */
export const REPAIR: readonly RepairStep<SystemTweaksSettings, TweakOptions>[] = [
  TMP_CLEANUP,
  UPKEEP,
  PHPMYADMIN_TWEAK.repair.rules,
  FIREWALL_TWEAK.repair.rules,
  VHOST_GUARD_TWEAK.repair.guard,
  PHP_POOLS_TWEAK.repair.rules,
  FILE_MANAGER_GUARD_TWEAK.repair.guard,
  PANEL_CERT_TWEAK.repair.replace,
  VHOST_GUARD_TWEAK.repair.varnish,
  CLPCTL_GUARD_TWEAK.repair.wrapper,
  VHOST_GUARD_TWEAK.repair.stored,
  PANEL_PHP_TWEAK.repair.choice,
  BACKUP_COMPRESSION_TWEAK.repair.command,
  TELEMETRY_TWEAK.repair.block,
  MOTD_TWEAK.repair.message,
];

type Withdrawing = Tweak & { withdraw: WithdrawStep<SystemTweaksSettings, TweakOptions> };
type Restoring = Tweak & { restore: RestoreStep<SystemTweaksSettings, TweakOptions> };
type Warning = { warning(error: string): string };

/**
 * Disabling the addon. A failure in `first` or `locked` stops the withdrawal,
 * so the addon stays enabled, and each step already done that has a `putBack`
 * puts its protection back at once, latest first. A failure in `locked` also
 * starts repair, which puts back everything else the settings ask for.
 */
export const WITHDRAW: {
  first: readonly Withdrawing[];
  locked: readonly Withdrawing[];
  last: readonly (Withdrawing & { withdraw: Warning })[];
} = {
  // Before the settings lock: panel PHP refuses when CloudPanel's own PHP would not come back.
  first: [PANEL_PHP_TWEAK],
  locked: [
    // First under the lock: it throws when our wrapper is in place but its saved
    // original is gone, and then nothing else is withdrawn, so the protections stay.
    CLPCTL_GUARD_TWEAK,
    // Next: it refuses an edited backup command, and then the protections below stay.
    BACKUP_COMPRESSION_TWEAK,
    UPDATES_TWEAK, REAL_IP_TWEAK, PHPMYADMIN_TWEAK, LOGIN_JAILS_TWEAK, DATABASE_TWEAK,
    FILE_MANAGER_GUARD_TWEAK, VHOST_GUARD_TWEAK, PHP_POOLS_TWEAK,
  ],
  // None of these keeps the addon on: each failure is only a warning.
  last: [TELEMETRY_TWEAK, MOTD_TWEAK, FIREWALL_TWEAK],
};

/**
 * Enabling the addon. `locked` runs under the settings lock and stops at a
 * failure unless the step has a warning; `always` runs either way; `after`
 * runs once those succeed, each step under its own settings lock when its
 * tweak has settings, a failure only a warning.
 */
export const RESTORE: {
  locked: readonly Restoring[];
  always: readonly Restoring[];
  after: readonly (Restoring & { restore: Warning })[];
} = {
  locked: [
    UPDATES_TWEAK, UPLOAD_GUARD_TWEAK, REAL_IP_TWEAK, PHPMYADMIN_TWEAK, LOGIN_JAILS_TWEAK,
    // It inspects MySQL's units, which can be mid-restart, so a failure only warns: the guards after it must still come back.
    DATABASE_TWEAK,
    VHOST_GUARD_TWEAK, PHP_POOLS_TWEAK, FILE_MANAGER_GUARD_TWEAK, CLPCTL_GUARD_TWEAK,
    BACKUP_COMPRESSION_TWEAK, TELEMETRY_TWEAK, MOTD_TWEAK,
  ],
  always: [PANEL_PHP_TWEAK],
  after: [PANEL_CERT_TWEAK, FIREWALL_TWEAK],
};

type Locking = Extract<Tweak, { switch: unknown }> | Extract<Tweak, { lockOn: unknown }>;

/**
 * Lock settings: every protection root's lock covers, switched on in this
 * order, then root's lock. MySQL comes last and only when every other one came
 * on, since it restarts for a lock that will be written.
 */
export const LOCK_SETTINGS: { first: readonly Locking[]; last: readonly Locking[] } = {
  first: [
    UPLOAD_GUARD_TWEAK, REAL_IP_TWEAK, PHPMYADMIN_TWEAK, PANEL_CERT_TWEAK, VHOST_GUARD_TWEAK, PHP_POOLS_TWEAK,
    FILE_MANAGER_GUARD_TWEAK, CLPCTL_GUARD_TWEAK, TELEMETRY_TWEAK, LOGIN_JAILS_TWEAK,
  ],
  last: [DATABASE_TWEAK],
};
