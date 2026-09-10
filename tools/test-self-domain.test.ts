import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FAKEROOT = Bun.which("fakeroot");
const REPO = join(import.meta.dir, "..");

function runIdentityScenarios(wrapperName: string, identityPath: string): string {
  if (!FAKEROOT) throw new Error("fakeroot is required for root-ownership wrapper tests");
  const script = `
import { validateDomain, createActionContext } from "./lib/action-common.ts";
import { writeFileSync, chmodSync, unlinkSync } from "node:fs";

const ctx = createActionContext("${wrapperName}");
let out = "";
ctx.emitErr = (msg) => {
  out += msg + "\\n";
  throw new Error(msg);
};

function run_validations(...candidates) {
  for (const c of candidates) {
    try {
      const v = validateDomain(c, ctx, { identityPath: "${identityPath}" });
      out += "ACCEPT:" + v + "\\n";
    } catch {
      out += "REJECTED\\n";
    }
  }
}

writeFileSync("${identityPath}", "PRIMARY=Panel.Example.Test.\\nALIASES=WWW.Panel.Example.Test. *.panel.example.test\\n");
chmodSync("${identityPath}", 0o600);
run_validations("PANEL.EXAMPLE.TEST.", "www.panel.example.test.", "tenant.PANEL.Example.Test.", "panel.example.test");
run_validations("evilpanel.example.test", "panel.example.test.evil.test", "customer.example.test.");

writeFileSync("${identityPath}", "PRIMARY=panel.example.test\\nALIASES=~^.+$\\n");
run_validations("customer.example.test");

unlinkSync("${identityPath}");
run_validations("customer.example.test");

writeFileSync("${identityPath}", "PRIMARY=panel.example.test\\nALIASES=www.panel.example.test\\n");
chmodSync("${identityPath}", 0o620);
run_validations("customer.example.test");

process.stdout.write(out);
`;
  return execFileSync(FAKEROOT, [process.execPath, "-e", script], {
    cwd: REPO,
    encoding: "utf8",
  });
}

test.skipIf(!FAKEROOT)("both wrappers fail closed on the root-owned panel identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-self-domain-test-"));
  const identity = join(dir, "panel-identity.conf");
  const wrappers = ["stager", "instatic"];
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
