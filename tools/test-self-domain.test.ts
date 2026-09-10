import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ActionFailure, panelIdentityGuardForIdentity, parsePanelIdentity, readPanelIdentity,
} from "../cli/action-common";

function guardResult(identity: ReturnType<typeof parsePanelIdentity>, candidate: string): string {
  if (!identity) return "INVALID_IDENTITY";
  try {
    panelIdentityGuardForIdentity(candidate, identity);
    return `ACCEPT:${candidate.toLowerCase().replace(/\.$/, "")}`;
  } catch (error) {
    if (error instanceof ActionFailure) return `REJECTED: ${error.message}`;
    throw error;
  }
}

test("the shared identity parser and guard fail closed for both action ports", () => {
  const identity = parsePanelIdentity(
    "PRIMARY=Panel.Example.Test.\nALIASES=WWW.Panel.Example.Test. *.panel.example.test\n",
  );
  expect(identity).toEqual({
    primary: "panel.example.test",
    aliases: ["www.panel.example.test", "*.panel.example.test"],
  });

  const candidates = [
    "PANEL.EXAMPLE.TEST.",
    "www.panel.example.test.",
    "tenant.PANEL.Example.Test.",
    "panel.example.test",
    "evilpanel.example.test",
    "panel.example.test.evil.test",
    "customer.example.test.",
  ];
  const results = candidates.map((candidate) => guardResult(identity, candidate));
  expect(results.filter((value) => value.startsWith("REJECTED: refusing")).length).toBe(4);
  expect(results).toContain("ACCEPT:evilpanel.example.test");
  expect(results).toContain("ACCEPT:panel.example.test.evil.test");
  expect(results).toContain("ACCEPT:customer.example.test");

  expect(parsePanelIdentity("PRIMARY=panel.example.test\nALIASES=~^.+$\n")).toBeNull();
  expect(parsePanelIdentity("PRIMARY=panel.example.test\nALIASES=www.panel.example.test\nALIASES=other.example.test\n")).toBeNull();
});

test("the filesystem identity guard requires a regular root-owned non-writable file", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-self-domain-test-"));
  const identityPath = join(dir, "panel-identity.conf");
  try {
    writeFileSync(identityPath, "PRIMARY=panel.example.test\nALIASES=\n");
    chmodSync(identityPath, 0o600);
    const parsed = readPanelIdentity(identityPath);
    if (process.getuid?.() === 0) {
      expect(parsed).toEqual({ primary: "panel.example.test", aliases: [] });
    } else {
      expect(parsed).toBeNull();
    }

    chmodSync(identityPath, 0o620);
    expect(readPanelIdentity(identityPath)).toBeNull();
    rmSync(identityPath, { force: true });
    expect(readPanelIdentity(identityPath)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
