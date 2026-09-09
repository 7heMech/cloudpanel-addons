// Two addons patching one CloudPanel template.
//
// This is the scenario the previous injector could not survive, and none of it
// was visible with a single addon installed. Pristine state was keyed by the
// addon rather than by the template, so the second addon to install snapshotted
// a file that already held the first addon's block -- stripped as if it were
// its own. Installing B deleted A's nav entry, the two reconciliation timers
// then overwrote each other every fifteen minutes, and uninstalling either one
// removed both because the markers were a module-level constant.
//
// Runs against a throwaway template, never the panel's own.

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { reconcile, type Injection } from "../cli/inject";
import { headerTarget } from "../lib/panel-nav";
import type { AddonTarget } from "../cli/paths";

let failed = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ok    ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`); failed++; }
}

// Everything happens under a temporary directory: this must not touch the
// panel's templates, must not disturb a real installation's snapshots, and must
// not need root to write under /var/lib.
const dir = mkdtempSync(`${tmpdir()}/inject-test-`);
const stateDir = `${dir}/state`;
const PATHS = { templatesDir: dir, stateDir };
const TEMPLATE = "header.html.twig";
const file = `${dir}/${TEMPLATE}`;
const ORIGINAL = `<html>\n<div class="nav-link-container w-100">\n</div>\n</html>\n`;
writeFileSync(file, ORIGINAL);

const target = (slug: string, label: string): AddonTarget => ({
  slug,
  template: TEMPLATE,
  anchorAfter: '<div class="nav-link-container w-100">',
  required: true,
  snippet: (url) => `\n  <a href="${url}">${label}</a>`,
});
const A: Injection = { addon: "alpha", target: target("nav", "AlphaNav"), url: "https://a.example.com" };
const B: Injection = { addon: "bravo", target: target("nav", "BravoNav"), url: "https://b.example.com" };

const body = () => readFileSync(file, "utf-8");
const hasA = () => body().includes("AlphaNav");
const hasB = () => body().includes("BravoNav");

reconcile([A], PATHS);
check("addon A alone is present", hasA() && !hasB());

reconcile([A, B], PATHS);
check("installing addon B keeps addon A", hasA(), body());
check("installing addon B adds addon B", hasB());

// The reconciliation timers run independently and repeatedly.
for (let i = 0; i < 3; i++) reconcile([A, B], PATHS);
check("repeated reconciliation is idempotent", hasA() && hasB());
const settled = body();
reconcile([A, B], PATHS);
check("the rendered file settles byte-for-byte", body() === settled);
check("neither addon's block is duplicated",
  (body().match(/AlphaNav/g) ?? []).length === 1 && (body().match(/BravoNav/g) ?? []).length === 1);

// Uninstalling one addon is reconciling without it.
reconcile([B], PATHS);
check("uninstalling addon A removes only addon A", !hasA() && hasB(), body());

reconcile([B], PATHS);
check("addon B survives a later reconciliation", hasB());

// Uninstalling the last addon restores the template exactly.
reconcile([], PATHS);
check("removing the last addon restores the original template", body() === ORIGINAL,
  JSON.stringify(body()));

const leftover = existsSync(stateDir) ? readdirSync(stateDir) : [];
check("no snapshot state is left behind", leftover.length === 0, leftover.join(", "));

// The shipped header targets preserve native order and support either addon alone.
const navOriginal = `<div class="nav-link-container w-100"><a>Dashboard</a>${headerTarget("Instatic").anchorAfter}</div>`;
writeFileSync(file, navOriginal);
const shipped = ["Instatic", "Stager"].map((name) => ({
  addon: name.toLowerCase(), target: { ...headerTarget(name), template: TEMPLATE }, url: `https://addons.example.com/${name.toLowerCase()}`,
}));
reconcile(shipped, PATHS);
check("native links precede addon navigation", body().indexOf("Dashboard") < body().indexOf("clp_sites") && body().indexOf("clp_sites") < body().indexOf("clp-addon-nav"));
check("addon navigation is alphabetical", body().indexOf(">Instatic</a>") < body().indexOf(">Stager</a>"));
check("both shipped links are inline and have no Bootstrap nav-link class", body().includes(">Instatic</a>") && body().includes(">Stager</a>") && !body().includes('class="nav-link"'));
reconcile([shipped[1]!], PATHS);
check("Stager navigation remains when Instatic is removed", body().includes(">Stager</a>") && !body().includes(">Instatic</a>"));
reconcile([], PATHS);
check("removing shipped navigation restores native header", body() === navOriginal);

rmSync(dir, { recursive: true, force: true });
const passed = 15 - failed;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
