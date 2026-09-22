// No credential outlives the job that carried it. sudo journals this action
// binary's whole COMMAND line -- verified against this box's own journal -- so
// an argument does not merely appear in `ps` for the life of the process, it
// is written down permanently. `--mfa` put the authentication code there, and
// the validator deliberately accepts a RECOVERY code, which does not expire.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCloneCredentials } from "../addons/stager/action";

const repo = join(import.meta.dir, "..");

function source(path: string): string {
  return readFileSync(join(repo, path), "utf-8");
}

describe("credentials never reach argv", () => {
  test("the action takes no --mfa argument, and nothing builds one", () => {
    expect(source("addons/stager/action.ts")).not.toInclude("--mfa");
    expect(source("addons/stager/app/service.ts")).not.toMatch(/args\.push\([^)]*"--mfa"/);
  });

  test("both credentials are read from stdin, and both are put there", () => {
    const action = source("addons/stager/action.ts");
    expect(action).toInclude("parseCloneCredentials");
    expect(action).toInclude('readFileSync(0, "utf8")');
    expect(source("addons/stager/app/service.ts")).toInclude('${instatic.password}\\n${instatic.mfaCode ?? ""}\\n');
  });
});

// Exactly two fields, only the caller's terminator removed, and any other
// shape refused rather than trimmed. The count is fixed because a variable one
// cannot tell a password containing a newline from a password followed by a
// code -- and where the tail looked like a code, the run went on and
// authenticated with a shortened secret.
describe("the stdin framing", () => {
  function parse(stdin: string): string {
    try {
      const result = parseCloneCredentials(stdin);
      return `P=${result.password}|M=${result.mfa}`;
    } catch {
      return "REFUSED";
    }
  }

  test("a password with no code is still two fields", () => {
    expect(parse("hunter2\n\n")).toBe("P=hunter2|M=");
  });

  test("a password and a code parse as two", () => {
    expect(parse("hunter2\n123456\n")).toBe("P=hunter2|M=123456");
  });

  test("a password ending in a space keeps it", () => {
    expect(parse("hunter2 \n\n")).toBe("P=hunter2 |M=");
  });

  test("a single line is refused rather than read as a bare password", () => {
    expect(parse("hunter2\n")).toBe("REFUSED");
  });

  test("a password containing a newline is refused, not silently shortened", () => {
    expect(parse("hunter2\nabc1234\nrest\n")).toBe("REFUSED");
  });
});

describe("what a finished or failed job leaves behind", () => {
  const unwind = () => {
    const action = source("addons/stager/action.ts");
    const rollback = action.slice(action.indexOf("function rollbackRun"));
    return rollback.slice(0, rollback.indexOf("\nfunction newRunContext"));
  };

  // Deleted, not merely 0600. The code had no deletion at all and the files
  // survived the fourteen days a job record is kept.
  test("both credentials are deleted once the sign-in has succeeded", () => {
    expect(source("addons/stager/action.ts"))
      .toInclude('["srcPassword", "mfa", "site-bundle.zip", "cookies-src", "cookies-dst"');
  });

  test("the rollback removes them and both cookie jars", () => {
    const body = unwind();
    expect(body).toInclude('"mfa"');
    expect(body).toInclude('"cookies-src"');
    expect(body).toInclude('"cookies-dst"');
  });

  test("and revokes any session the run opened rather than leaving one live", () => {
    expect(unwind().match(/instaticLogout/g) ?? []).toHaveLength(2);
  });

  test("a job systemd-run would not start loses them too", () => {
    const action = source("addons/stager/action.ts");
    const refused = action.slice(action.indexOf("const started = startJobUnit({"), action.indexOf("const started = startJobUnit({") + 900);
    expect(refused).toInclude('rmSync(join(dir, "srcPassword")');
    expect(refused).toInclude('rmSync(join(dir, "mfa")');
  });

  // curl writes its output and its jar with the process umask, and cmdRun
  // inherits UMask=0022 from the unit.
  test("curl's output file and each cookie jar are created 0600 before curl writes", () => {
    const action = source("addons/stager/action.ts");
    expect(action.match(/tempSecretFile\(output\)/g) ?? []).toHaveLength(2);
    expect(action.match(/tempSecretFile\(jar\)/g) ?? []).toHaveLength(2);
    expect(action).not.toInclude("chmodSync(ctx.exportZip");
  });

  // execFile's error.message is "Command failed: <full argv>".
  test("an action failure is not logged with its own argv", () => {
    const code = source("addons/stager/app/service.ts")
      .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(code).not.toInclude("error.message");
  });
});
