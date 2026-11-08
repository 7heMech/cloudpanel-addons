import { expect, test } from "bun:test";
import { SYSTEM_TWEAKS_HANDLERS } from "../addons/system-tweaks/action";
import { BACKUP_COMPRESSION_TWEAK } from "../addons/system-tweaks/backup-compression";
import { CLPCTL_GUARD_TWEAK } from "../addons/system-tweaks/clpctl-guard";
import { DATABASE_TWEAK } from "../addons/system-tweaks/database";
import { FILE_MANAGER_GUARD_TWEAK } from "../addons/system-tweaks/file-manager-guard";
import { FIREWALL_TWEAK } from "../addons/system-tweaks/firewall";
import { LOGIN_JAILS_TWEAK } from "../addons/system-tweaks/login-jails";
import { MOTD_TWEAK } from "../addons/system-tweaks/motd";
import { PANEL_CERT_TWEAK } from "../addons/system-tweaks/panel-cert";
import { PANEL_PHP_TWEAK } from "../addons/system-tweaks/panel-php";
import { PHPMYADMIN_TWEAK } from "../addons/system-tweaks/phpmyadmin";
import { PHP_POOLS_TWEAK } from "../addons/system-tweaks/pool-isolation";
import { REAL_IP_TWEAK } from "../addons/system-tweaks/real-ip";
import { HARDENING, LOCK_SETTINGS, REPAIR, RESTORE, STATE, TWEAKS, UPKEEP, WITHDRAW } from "../addons/system-tweaks/registry";
import { TELEMETRY_TWEAK } from "../addons/system-tweaks/telemetry";
import { UPDATES_TWEAK } from "../addons/system-tweaks/updates";
import { UPLOAD_GUARD_TWEAK } from "../addons/system-tweaks/upload-progress";
import { SYSTEM_TWEAKS_VERBS } from "../addons/system-tweaks/verbs";
import { VHOST_GUARD_TWEAK } from "../addons/system-tweaks/vhost-guard";

const NAMES = new Map<object, string>([
  [UPDATES_TWEAK, "updates"], [UPLOAD_GUARD_TWEAK, "upload guard"], [REAL_IP_TWEAK, "real IP"], [VHOST_GUARD_TWEAK, "vhost guard"],
  [PHP_POOLS_TWEAK, "PHP pools"], [PHPMYADMIN_TWEAK, "phpMyAdmin"], [FILE_MANAGER_GUARD_TWEAK, "File Manager guard"],
  [PANEL_CERT_TWEAK, "panel cert"], [LOGIN_JAILS_TWEAK, "login jails"], [DATABASE_TWEAK, "database"], [CLPCTL_GUARD_TWEAK, "clpctl guard"],
  [TELEMETRY_TWEAK, "telemetry"], [MOTD_TWEAK, "motd"], [BACKUP_COMPRESSION_TWEAK, "backup compression"], [PANEL_PHP_TWEAK, "panel PHP"],
  [FIREWALL_TWEAK, "firewall"],
]);
const names = (tweaks: readonly object[]) => tweaks.map((tweak) => NAMES.get(tweak) ?? "unnamed");

test("every tweak is in the registry once", () => {
  expect(new Set(TWEAKS).size).toBe(TWEAKS.length);
  expect(names(TWEAKS).sort()).toEqual([...NAMES.values()].sort());
});

// Each order below is what the addon did before the registry, kept as it was.
// Changing one changes what a failure leaves behind; see docs/decisions/system-tweaks.md.

test("disabling the addon withdraws panel PHP first, the clpctl guard first under the lock, and the best-effort ones last", () => {
  expect(names(WITHDRAW.first)).toEqual(["panel PHP"]);
  expect(names(WITHDRAW.locked)).toEqual([
    "clpctl guard", "backup compression", "updates", "real IP", "phpMyAdmin", "login jails", "database",
    "File Manager guard", "vhost guard", "PHP pools",
  ]);
  expect(names(WITHDRAW.last)).toEqual(["telemetry", "motd", "firewall"]);
  // What a later failure puts back at once, since the addon then stays enabled; repair is queued for the rest.
  const putBack = [...WITHDRAW.first, ...WITHDRAW.locked].filter((tweak) => tweak.withdraw.putBack);
  expect(names(putBack)).toEqual(["panel PHP", "clpctl guard"]);
});

test("enabling the addon restores panel PHP whatever the rest does, and the panel certificate and firewall after", () => {
  expect(names(RESTORE.locked)).toEqual([
    "updates", "upload guard", "real IP", "phpMyAdmin", "login jails", "database", "vhost guard", "PHP pools",
    "File Manager guard", "clpctl guard", "backup compression", "telemetry", "motd",
  ]);
  expect(names(RESTORE.always)).toEqual(["panel PHP"]);
  expect(names(RESTORE.after)).toEqual(["panel cert", "firewall"]);
  // These warn and let the rest come back; every other locked step stops it.
  expect(names(RESTORE.locked.filter((tweak) => tweak.restore.warning))).toEqual(["database", "backup compression", "telemetry", "motd"]);
});

test("repair runs its steps in a fixed order, the quick ones under one lock", () => {
  expect(REPAIR.map((step) => step.label)).toEqual([
    "/tmp cleanup", null, "phpMyAdmin rules", "firewall", "vhost guard", "PHP pools", "File Manager guard", "panel certificate",
    "Varnish backends", "clpctl wrapper guard", "stored site settings", "panel PHP", "remote backup compression",
    "CloudPanel telemetry", "SSH login message",
  ]);
  expect(REPAIR[1]).toBe(UPKEEP);
  expect(REPAIR.filter((step) => !step.locked).map((step) => step.label)).toEqual(["/tmp cleanup", "firewall", "stored site settings", "panel PHP"]);
});

test("Lock settings turns the protections on in this order, MySQL last", () => {
  expect(names(LOCK_SETTINGS.first)).toEqual([
    "upload guard", "real IP", "phpMyAdmin", "panel cert", "vhost guard", "PHP pools", "File Manager guard", "clpctl guard",
    "telemetry", "login jails",
  ]);
  expect(names(LOCK_SETTINGS.last)).toEqual(["database"]);
});

test("every step a tweak declares runs in its phase exactly once", () => {
  const steps = (tweak: (typeof TWEAKS)[number]) => "repair" in tweak ? Object.values(tweak.repair) : [];
  const upkeep = [UPDATES_TWEAK.repair.upkeep, REAL_IP_TWEAK.repair.upkeep, LOGIN_JAILS_TWEAK.repair.upkeep, DATABASE_TWEAK.repair.upkeep];
  const scheduled = [...REPAIR, ...upkeep];
  for (const tweak of TWEAKS) {
    for (const step of steps(tweak)) expect(scheduled.filter((each) => each === step).length, NAMES.get(tweak)).toBe(1);
    const count = (list: readonly object[]) => list.filter((each) => each === tweak).length;
    expect(count(STATE), NAMES.get(tweak)).toBe(1);
    expect(count([...WITHDRAW.first, ...WITHDRAW.locked, ...WITHDRAW.last]), NAMES.get(tweak)).toBe("withdraw" in tweak ? 1 : 0);
    expect(count([...RESTORE.locked, ...RESTORE.always, ...RESTORE.after]), NAMES.get(tweak)).toBe("restore" in tweak ? 1 : 0);
    expect(count([...HARDENING, MOTD_TWEAK]), NAMES.get(tweak)).toBe("row" in tweak ? 1 : 0);
  }
});

test("the page's Hardening card lists its rows in this order", () => {
  expect(names(HARDENING)).toEqual([
    "panel PHP", "upload guard", "real IP", "phpMyAdmin", "database", "panel cert", "vhost guard", "PHP pools",
    "File Manager guard", "clpctl guard", "telemetry",
  ]);
});

test("every declared verb has one handler, and each switch is its tweak's", () => {
  expect(Object.keys(SYSTEM_TWEAKS_HANDLERS).sort()).toEqual(Object.keys(SYSTEM_TWEAKS_VERBS).sort());
  const switches = TWEAKS.flatMap((tweak) => "switch" in tweak ? [tweak.switch.verb] : []);
  expect(switches.sort()).toEqual([
    "set-clpctl-guard", "set-database-loopback", "set-file-manager-guard", "set-motd", "set-panel-cert", "set-php-pools",
    "set-phpmyadmin", "set-real-ip", "set-telemetry", "set-upload-guard", "set-vhost-guard",
  ]);
});
