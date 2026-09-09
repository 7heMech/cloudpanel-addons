import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const dir = mkdtempSync(`${tmpdir()}/certificate-test-`);
try {
  writeFileSync(`${dir}/clpctl`, '#!/bin/sh\nprintf "CALLED:%s\\n" "$@"\nexit "${CERT_STATUS:-0}"\n', { mode: 0o755 });
  for (const [choice, status] of [["yes", "0"], ["yes", "1"], ["no", "0"], ["invalid", "0"]]) {
    const source = `import {requestCertificate} from ${JSON.stringify(resolve("cli/certificate.ts"))}; requestCertificate("addons.example.com", ${JSON.stringify(choice)});`;
    const result = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CERT_STATUS: status } });
    const out = result.stdout + result.stderr;
    assert.equal(out.includes("CALLED:lets-encrypt:install:certificate"), choice === "yes");
    if (choice === "yes") assert.ok(out.includes("CALLED:--domainName=addons.example.com"));
    if (choice === "yes" && status === "1") assert.ok(out.includes("issuance failed") && out.includes("Check DNS"));
    assert.equal(result.status === 0, choice !== "invalid");
    console.log(`ok certificate ${choice}, command status ${status}`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
