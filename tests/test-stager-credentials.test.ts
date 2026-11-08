// No credential outlives the job that carried it. sudo journals this action
// binary's whole COMMAND line -- verified against this box's own journal -- so
// an argument does not merely appear in `ps` for the life of the process, it
// is written down permanently. `--mfa` put the authentication code there, and
// the validator deliberately accepts a RECOVERY code, which does not expire.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCloneCredentials } from "../addons/stager/action";
import { jobGet, listJobIds } from "../lib/job-store";

const repo = join(import.meta.dir, "..");

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
  const SOURCE = "app.example.test";
  const TARGET = "stg.example.test";

  // curl stands in for the source instance: it signs in (asking for the code),
  // then refuses the export, so the run fails after a session was opened. Each
  // call records the URL, whether the credentials were still on disk, and the
  // mode of the files it was about to write.
  const CURL = String.raw`#!/bin/sh
out=""; jar=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -c) jar="$2"; shift ;;
    -b|-w|-X|-H|--max-time|--data-binary) shift ;;
    http://*) url="$1" ;;
  esac
  shift
done
dir=$(dirname "$out")
have() { [ -e "$dir/$1" ] && echo y || echo n; }
echo "$url pw=$(have srcPassword) mfa=$(have mfa) out=$(stat -c %a "$out") jar=$(stat -c %a "$jar")" >> "$CURL_LOG"
case "$url" in
  */cms/login) printf '{"mfaRequired":true}' > "$out"; echo session > "$jar"; printf 200 ;;
  */mfa/verify) printf '{}' > "$out"; printf 200 ;;
  */cms/export*) printf 'export refused' > "$out"; printf 500 ;;
  */cms/logout) printf 200 ;;
  *) printf 404 ;;
esac
`;

  function box() {
    const root = mkdtempSync(join(tmpdir(), "clp-stager-credentials-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), CURL, { mode: 0o755 });
    writeFileSync(join(bin, "getent"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    writeFileSync(join(bin, "systemd-run"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(bin, "clp-addons"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const panelDb = join(root, "panel.db");
    const db = new Database(panelDb);
    db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, user TEXT, root_directory TEXT, application TEXT, reverse_proxy_url TEXT, vhost_template TEXT)");
    db.run("CREATE TABLE php_settings (site_id INTEGER, php_version TEXT)");
    db.run("CREATE TABLE database (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT)");
    db.query("INSERT INTO site (id, domain_name, type, user, root_directory, application, reverse_proxy_url) VALUES (1, ?, 'reverse-proxy', 'app', '', '', 'http://127.0.0.1:39500')").run(SOURCE);
    db.close();
    mkdirSync(join(root, "instatic", SOURCE), { recursive: true });
    writeFileSync(join(root, "instatic", SOURCE, "meta.json"), JSON.stringify({ domain: SOURCE, port: "39500", tag: "0.0.18" }));
    const paths = {
      panelDb, lockDir: join(root, "locks"), jobsDir: join(root, "jobs"), tempDir: root,
      instaticDataDir: join(root, "instatic"), actionBinary: join(bin, "clp-addons"), clpctl: join(bin, "clp-addons"),
    };
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CURL_LOG: join(root, "curl.log") } as Record<string, string>;
    return { root, bin, paths, env };
  }

  function runAction(b: ReturnType<typeof box>, argv: string[], input = ""): void {
    // The action refuses a domain without the panel's root-owned identity file.
    const script = `
      import { mock } from "bun:test";
      Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
      const realCommon = await import("./lib/panel-identity.ts");
      mock.module("./lib/panel-identity.ts", () => ({
        ...realCommon,
        readPanelIdentity: () => ({ primary: "panel.example.test", aliases: [] }),
      }));
      const { runStagerAction } = await import("./addons/stager/action.ts");
      process.exit(await runStagerAction(${JSON.stringify(argv)}, { paths: ${JSON.stringify(b.paths)} }));
    `;
    Bun.spawnSync([process.execPath, "-e", script], { cwd: repo, env: b.env, stdin: Buffer.from(input) });
  }

  function failedRun(): { left: string[]; curl: string[]; state: string; error: string } {
    const b = box();
    try {
      const id = "20260910T093000Z-a1b2c3";
      const dir = join(b.paths.jobsDir, id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fields = { source: SOURCE, target: TARGET, tls: "no", port: "39501", email: "admin@example.test", mfa: "123456", srcPassword: "hunter2", state: "queued" };
      for (const [name, value] of Object.entries(fields)) writeFileSync(join(dir, name), `${value}\n`, { mode: 0o600 });
      runAction(b, ["run", "--job", id]);
      return {
        left: readdirSync(dir).filter((name) => ["srcPassword", "mfa", "cookies-src", "cookies-dst", ".api-req", ".api-out", "site-bundle.zip"].includes(name)),
        curl: readFileSync(join(b.root, "curl.log"), "utf8").trim().split("\n"),
        state: jobGet(dir, "state"),
        error: jobGet(dir, "error"),
      };
    } finally {
      rmSync(b.root, { recursive: true, force: true });
    }
  }

  const run = failedRun();

  test("the run signed in, then failed on the export", () => {
    expect(run.curl.map((line) => line.split(" ")[0])).toEqual([
      "http://127.0.0.1:39500/admin/api/cms/login",
      "http://127.0.0.1:39500/admin/api/cms/auth/mfa/verify",
      "http://127.0.0.1:39500/admin/api/cms/export?includeSite=1&includeMedia=1",
      "http://127.0.0.1:39500/admin/api/cms/logout",
    ]);
    expect(run.state).toBe("failed");
    expect(run.error).toInclude("refused the export (HTTP 500)");
  });

  // Deleted, not merely 0600, and as soon as the sign-in has succeeded: a job
  // record is kept for fourteen days.
  test("both credentials are deleted once the sign-in has succeeded", () => {
    expect(run.curl[1]).toInclude("pw=y mfa=y");
    expect(run.curl[2]).toInclude("pw=n mfa=n");
  });

  test("the rollback removes them, both cookie jars and curl's files", () => {
    expect(run.left).toEqual([]);
  });

  test("and revokes the session the run opened rather than leaving one live", () => {
    expect(run.curl.at(-1)!.split(" ")[0]).toEndWith("/admin/api/cms/logout");
  });

  // curl writes its output and its jar with the process umask, and cmdRun
  // inherits UMask=0022 from the unit.
  test("curl's output file and each cookie jar are created 0600 before curl writes", () => {
    for (const line of run.curl) expect(line).toEndWith("out=600 jar=600");
  });

  test("a job systemd-run would not start loses them too", () => {
    const b = box();
    try {
      runAction(b, [
        "clone", "--source", SOURCE, "--target", TARGET, "--port", "39501", "--email", "admin@example.test",
      ], "hunter2\n123456\n");
      const [id] = listJobIds(b.paths.jobsDir);
      const dir = join(b.paths.jobsDir, id!);
      expect(jobGet(dir, "state")).toBe("failed");
      expect(jobGet(dir, "error")).toBe("could not start the clone job");
      expect(existsSync(join(dir, "srcPassword"))).toBe(false);
      expect(existsSync(join(dir, "mfa"))).toBe(false);
    } finally {
      rmSync(b.root, { recursive: true, force: true });
    }
  });
});
