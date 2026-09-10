import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STAGER = join(import.meta.dir, "../addons/stager/wrapper/clp-action-stager");
const INSTATIC = join(import.meta.dir, "../addons/instatic/wrapper/clp-action-instatic");
const IDENTITY_PATH = "/etc/clp-addons/panel-identity.conf";
const FAKEROOT = Bun.which("fakeroot");

function validationScript(wrapper: string, identityPath: string): string {
  const source = readFileSync(wrapper, "utf8");
  const marker = "\n# --- argument parsing";
  const end = source.indexOf(marker);
  if (end === -1) throw new Error(`${wrapper} has no argument-parsing boundary`);
  return source.slice(0, end).replace(
    `readonly PANEL_IDENTITY_FILE="${IDENTITY_PATH}"`,
    `readonly PANEL_IDENTITY_FILE="${identityPath}"`,
  );
}

function runIdentityScenarios(wrapper: string, identityPath: string): string {
  if (!FAKEROOT) throw new Error("fakeroot is required for root-ownership wrapper tests");
  const script = `${validationScript(wrapper, identityPath)}
run_validations() {
  for candidate in "$@"; do
    if ( validate_domain "$candidate" domain; printf 'ACCEPT:%s\\n' "$VALIDATED_DOMAIN" ); then
      :
    else
      printf 'REJECTED\\n'
    fi
  done
}

printf '%s\\n' 'PRIMARY=Panel.Example.Test.' 'ALIASES=WWW.Panel.Example.Test. *.panel.example.test' > "$PANEL_IDENTITY_FILE"
chmod 600 "$PANEL_IDENTITY_FILE"
run_validations PANEL.EXAMPLE.TEST. www.panel.example.test. tenant.PANEL.Example.Test. panel.example.test
run_validations evilpanel.example.test panel.example.test.evil.test customer.example.test.

printf '%s\\n' 'PRIMARY=panel.example.test' 'ALIASES=~^.+$' > "$PANEL_IDENTITY_FILE"
run_validations customer.example.test

rm -f "$PANEL_IDENTITY_FILE"
run_validations customer.example.test

printf '%s\\n' 'PRIMARY=panel.example.test' 'ALIASES=www.panel.example.test' > "$PANEL_IDENTITY_FILE"
chmod 620 "$PANEL_IDENTITY_FILE"
run_validations customer.example.test`;
  return execFileSync(FAKEROOT, ["bash", "-c", script, "_"], { encoding: "utf8" });
}

test.skipIf(!FAKEROOT)("both wrappers fail closed on the root-owned panel identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-self-domain-test-"));
  const identity = join(dir, "panel-identity.conf");
  const wrappers = [STAGER, INSTATIC];
  try {
    for (const wrapper of wrappers) {
      const result = runIdentityScenarios(wrapper, identity);
      expect(result.match(/panel site or alias/g)?.length).toBe(4);
      expect(result.match(/REJECTED/g)?.length).toBe(7);
      expect(result).toContain("ACCEPT:evilpanel.example.test");
      expect(result).toContain("ACCEPT:panel.example.test.evil.test");
      expect(result).toContain("ACCEPT:customer.example.test");
      expect(result.match(/missing or malformed/g)?.length).toBe(3);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 15_000 });
