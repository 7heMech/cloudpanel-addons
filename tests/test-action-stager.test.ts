import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  applicationOk, dotenvProblem, holdCloneMail, newRunContext, panelUpdateSite, rewriteDotenvContent,
  rewriteWpConfig, rollbackRun, vhostTemplateExists, type StagerActionPaths,
} from "../addons/stager/action";
import { expandTarget } from "../addons/stager/app/service";
import { CLIENT_JS } from "../addons/stager/app/views";

const repo = join(import.meta.dir, "..");

function runAction(paths: Partial<StagerActionPaths>, argv: string[], prelude = ""): string {
  const script = `${prelude}
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true });
    const { runStagerAction } = await import("./addons/stager/action.ts");
    const code = await runStagerAction(${JSON.stringify(argv)}, { paths: ${JSON.stringify(paths)} });
    process.exit(code);
  `;
  return execFileSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8" }).trim();
}

function writeJob(dir: string, fields: Record<string, string>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [field, value] of Object.entries(fields)) {
    writeFileSync(join(dir, field), `${value}\n`, { mode: 0o600 });
    chmodSync(join(dir, field), 0o600);
  }
  writeFileSync(join(dir, "log"), "line 1\nline 2\n", { mode: 0o600 });
  chmodSync(join(dir, "log"), 0o600);
}

test("the Stager sites action keeps its one-object field contract", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-action-test-"));
  const panelDb = join(root, "panel.db");
  try {
    const script = `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(panelDb)});
      db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, user TEXT, root_directory TEXT, application TEXT, reverse_proxy_url TEXT, vhost_template TEXT)");
      db.run("CREATE TABLE php_settings (site_id INTEGER, php_version TEXT)");
      db.run("CREATE TABLE database (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT)");
      db.query("INSERT INTO site (id, domain_name, type, user, root_directory, application) VALUES (?, ?, ?, ?, ?, ?)").run(1, "alpha.example.test", "php", "alpha", "/home/alpha/htdocs/alpha.example.test", "WordPress");
      db.query("INSERT INTO php_settings (site_id, php_version) VALUES (?, ?)").run(1, "8.3");
      db.close();
    `;
    execFileSync(process.execPath, ["-e", script], { cwd: repo, encoding: "utf8" });
    const output = runAction({ panelDb, lockDir: join(root, "locks"), jobsDir: join(root, "jobs") }, ["sites"]);
    expect(output).toBe('{"ok":true,"data":{"sites":[{"domain":"alpha.example.test","siteType":"php","siteUser":"alpha","phpVersion":"8.3","application":"WordPress","databases":0}]}}');
    expect(output.split("\n")).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stager jobs are newest first and malformed results stay in one JSON reply", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-action-test-"));
  const jobsDir = join(root, "jobs");
  try {
    writeJob(join(jobsDir, "20260910T120000Z-abcdef"), {
      source: "alpha.example.test",
      target: "staging.example.test",
      state: "done",
      step: "recording the result",
      createdAt: "2026-09-10T12:00:00Z",
    });
    writeFileSync(join(jobsDir, "20260910T120000Z-abcdef", "result.json"), "{\n", { mode: 0o600 });
    chmodSync(join(jobsDir, "20260910T120000Z-abcdef", "result.json"), 0o600);
    writeJob(join(jobsDir, "20260910T130000Z-abcdef"), {
      source: "beta.example.test",
      target: "staging-beta.example.test",
      state: "queued",
      step: "queued",
      createdAt: "2026-09-10T13:00:00Z",
    });

    const output = runAction({ panelDb: join(root, "missing.db"), lockDir: join(root, "locks"), jobsDir }, ["jobs"]);
    const reply = JSON.parse(output) as { ok: boolean; data: { jobs: Array<{ id: string; result: unknown; panelSite: unknown }> } };
    expect(reply.ok).toBe(true);
    expect(reply.data.jobs.map((job) => job.id)).toEqual([
      "20260910T130000Z-abcdef",
      "20260910T120000Z-abcdef",
    ]);
    expect(reply.data.jobs[1]!.result).toBeNull();
    expect(reply.data.jobs[0]!.panelSite).toBeNull();
    expect(output.split("\n")).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The panel identity is trusted only from a root-owned file, which a test
// cannot write unprivileged, so the lookup of it is the one seam stubbed here.
const IDENTITY_STUB = `
  import { mock } from "bun:test";
  mock.module("./lib/panel-identity.ts", async () => {
    const real = await import("./lib/panel-identity.ts?stubbed-identity");
    const identity = { primary: "panel.example.test", aliases: [] };
    return {
      ...real,
      readPanelIdentity: () => identity,
      validateDomain: (value) => {
        real.panelIdentityGuardForIdentity(value, identity);
        return value.toLowerCase();
      },
    };
  });
`;

function testPaths(root: string, overrides: Partial<StagerActionPaths> = {}): StagerActionPaths {
  return {
    lockDir: join(root, "locks"),
    dataBaseDir: join(root, "data"),
    jobsDir: join(root, "jobs"),
    panelDb: join(root, "panel.db"),
    clpctl: join(root, "missing-clpctl"),
    panelIdentityFile: join(root, "identity"),
    nginxVhostDir: join(root, "vhosts"),
    instaticDataDir: join(root, "instatic"),
    actionBinary: join(root, "missing-clp-addons"),
    tempDir: root,
    sqlite3: "sqlite3",
    smtpConfigFile: join(root, "smtp.conf"),
    ...overrides,
  };
}

test("manual stager prune keeps its exact JSON stdout reply", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-action-test-"));
  const jobsDir = join(root, "jobs");
  const vhostsDir = join(root, "vhosts");
  const tempDir = join(root, "tmp");
  mkdirSync(vhostsDir);
  mkdirSync(tempDir);
  try {
    const output = runAction({
      jobsDir,
      lockDir: join(root, "locks"),
      nginxVhostDir: vhostsDir,
      tempDir,
    }, ["prune"], IDENTITY_STUB);
    expect(output).toBe('{"ok":true,"data":{"removed":0,"stuck":0,"vhostsRecovered":0,"promotionsRecovered":0,"rootsRemoved":0}}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The bare-label shorthand the original wrapper script accepted. It is
// expanded in the app rather than in the action binary, which must reject its
// input rather than rewrite it, so this is the only place the rule is
// implemented.
describe("the target shorthand", () => {
  for (const [input, expected, why] of [
    ["stg", "stg.example.com", "a bare label becomes a subdomain of the source"],
    ["staging.other.test", "staging.other.test", "a full hostname is left alone"],
    ["  STG ", "stg.example.com", "case and surrounding space are normalised"],
    ["stg.example.com.", "stg.example.com", "a trailing dot is dropped rather than making an empty label"],
    ["   ", "", "an empty label expands to nothing rather than to the source"],
  ] as const) {
    test(why, () => {
      expect(expandTarget(input, "example.com")).toBe(expected);
    });
  }

  test("a bare label goes under the bare domain of a www site", () => {
    expect(expandTarget("stg", "www.example.com")).toBe("stg.example.com");
    expect(expandTarget("stg", "shop.example.com")).toBe("stg.shop.example.com");
  });

  test("the page's script expands it the same way", () => {
    const page = { readyState: "loading", addEventListener() {} };
    const expand = new Function("document", `${CLIENT_JS}\nreturn expandTarget;`)(page) as typeof expandTarget;
    expect(expand("STG", "www.example.com")).toBe("stg.example.com");
  });
});

describe("a clone's mail while SMTP Relay is enabled", () => {
  test("goes to the Don't send profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stager-smtp-"));
    writeFileSync(join(dir, "smtp.conf"), "");
    const sent: string[] = [];
    const notes: string[] = [];
    await holdCloneMail({ smtpConfigFile: join(dir, "smtp.conf") }, "stg.example.com", notes, async (input) => { sent.push(input); });
    expect(sent.map((input) => JSON.parse(input))).toEqual([{ domains: ["stg.example.com"], profileId: "dont-send" }]);
    expect(notes.join(" ")).toContain("discards stg.example.com's mail");
    rmSync(dir, { recursive: true, force: true });
  });

  test("is left alone when SMTP Relay is not enabled", async () => {
    let calls = 0;
    const notes: string[] = [];
    await holdCloneMail({ smtpConfigFile: "/nonexistent/smtp.conf" }, "stg.example.com", notes, async () => { calls++; });
    expect(calls).toBe(0);
    expect(notes).toEqual([]);
  });

  test("becomes a note, not a failed clone, when the assignment fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stager-smtp-"));
    writeFileSync(join(dir, "smtp.conf"), "");
    const notes: string[] = [];
    await holdCloneMail({ smtpConfigFile: join(dir, "smtp.conf") }, "stg.example.com", notes, async () => {
      throw new Error("no such profile: dont-send");
    });
    expect(notes.join(" ")).toContain("could not be put in SMTP Relay's Don't send profile");
    rmSync(dir, { recursive: true, force: true });
  });
});

// `site.application` is the one value in the panel write that does not come
// from this addon. It is the *source* site's application name, and CloudPanel
// validates nothing on the way to it: VhostTemplateAddCommand stores
// `trim($input->getOption("name"))` as given, SiteAddPhpCommand copies that
// name into site.application verbatim, and /etc/sudoers.d/cloudpanel lets
// every local account run clpctlWrapper. Interpolating it was a SQL injection
// that escalated to an arbitrary root write, because the read-back runs
// `sqlite3 -readonly` as root and writefile() is compiled in even there.
describe("an application name may never reach SQL as text", () => {
  // Every stock template name on this box, plus the two site.application
  // values that force a character beyond [A-Za-z0-9]: PrestaShop 1.7 the dot,
  // and the stager's own throwaway template names the hyphen and the digits.
  const REAL = [
    "Generic", "WordPress", "Static", "ReverseProxy", "Nodejs", "Python", "WHMCS",
    "WooCommerce", "Laminas", "CakePHP 5", "CodeIgniter 4", "Contao 4", "Drupal 11",
    "Joomla 6", "Laravel 13", "Magento 2", "Matomo 5", "Mautic 7", "Moodle 5",
    "Neos 9", "Nextcloud 34", "OwnCloud 12", "PrestaShop 1.7", "Shopware 6",
    "Slim 4", "Symfony 8", "TYPO3 14", "Yii 2",
    "clp-stager-src2", "clp-stager-20260907T090213Z-56f3aa", "My_App",
  ];

  // The reproduced payloads. The first rewrote site.user to root; the second
  // reached an unrelated row; the third created a root-owned file through
  // writefile() under -readonly.
  const PAYLOADS = [
    "Generic', user = 'root",
    "Generic' WHERE 1=1; UPDATE site SET user = 'root",
    "Generic' AND 1=1; SELECT writefile('/tmp/x','ALL ALL=(ALL) NOPASSWD: ALL'); SELECT '1",
    "Generic'",
    'Generic"',
    "Generic;",
    "Generic--",
    "Generic\nWordPress",
    "Generic`id`",
    "Generic$(id)",
    "",
    " Generic",
    "Generic ",
    "-Generic",
    "../../etc/passwd",
    "x".repeat(65),
  ];

  for (const name of REAL) {
    test(`accepted: ${name}`, () => {
      expect(applicationOk(name)).toBe(true);
    });
  }

  for (const name of PAYLOADS) {
    test(`refused: ${JSON.stringify(name)}`, () => {
      expect(applicationOk(name)).toBe(false);
    });
  }

  // The panel write and the template lookup are where the name meets SQL.
  const panel = () => {
    const root = mkdtempSync(join(tmpdir(), "clp-stager-panel-"));
    const db = new Database(join(root, "panel.db"));
    db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, user TEXT, application TEXT, vhost_template TEXT, updated_at TEXT)");
    db.run("CREATE TABLE vhost_template (id INTEGER PRIMARY KEY, name TEXT)");
    db.query("INSERT INTO site (domain_name, type, user, application) VALUES (?, ?, ?, ?)").run("stg.example.test", "php", "stg", "Generic");
    db.query("INSERT INTO site (domain_name, type, user, application) VALUES (?, ?, ?, ?)").run("live.example.test", "php", "live", "WordPress");
    db.query("INSERT INTO vhost_template (name) VALUES (?)").run("WordPress");
    db.close();
    const rows = () => {
      const read = new Database(join(root, "panel.db"), { readonly: true });
      try {
        return read.query("SELECT domain_name, user, application FROM site ORDER BY id").all();
      } finally {
        read.close();
      }
    };
    return { root, paths: testPaths(root), rows };
  };

  // The write runs the sqlite3 shell as clp. Stand-ins for runuser and chown
  // let it run as the test's own user, and one for the shell gives the
  // statement the shell's readfile().
  const python = Bun.which("python3");
  const panelWrite = (application: string) => {
    const { root, paths, rows } = panel();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "runuser"), "#!/bin/sh\nshift 3\nexec \"$@\"\n", { mode: 0o755 });
    writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "sqlite3"), [
      `#!${python}`,
      "import sqlite3, sys",
      "db = sqlite3.connect(sys.argv[1])",
      "db.create_function('readfile', 1, lambda path: open(path, 'rb').read())",
      "db.executescript(sys.argv[2])",
      "db.commit()",
      "",
    ].join("\n"), { mode: 0o755 });
    const ctx = newRunContext("20260910T120000Z-abcdef", root, { ...paths, sqlite3: join(bin, "sqlite3") });
    ctx.target = "stg.example.test";
    ctx.siteCreated = true;
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    try {
      return { written: panelUpdateSite(ctx, "php", application), rows: rows() };
    } finally {
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  };
  const BEFORE = [
    { domain_name: "stg.example.test", user: "stg", application: "Generic" },
    { domain_name: "live.example.test", user: "live", application: "WordPress" },
  ];

  test.skipIf(!python)("the panel write stores a real name literally, on the target row only", () => {
    const { written, rows } = panelWrite("PrestaShop 1.7");
    expect(written).toBe(true);
    expect(rows).toEqual([{ ...BEFORE[0]!, application: "PrestaShop 1.7" }, BEFORE[1]!]);
  });

  for (const name of PAYLOADS.slice(0, 3)) {
    test.skipIf(!python)(`the panel write changes no row for ${JSON.stringify(name)}`, () => {
      const { written, rows } = panelWrite(name);
      expect(written).toBe(false);
      expect(rows).toEqual(BEFORE);
    });
  }

  // vhost_template_exists put the same value in a query and doubled the quotes
  // in it, which is sanitizing rather than rejecting. It must now refuse.
  describe("the template-exists lookup", () => {
    test("a name that fails the predicate is reported missing, not escaped", () => {
      const { root, paths } = panel();
      try {
        expect(vhostTemplateExists(paths, "WordPress' OR '1'='1")).toBe(false);
        expect(vhostTemplateExists(paths, "Generic")).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a legitimate name is still queried", () => {
      const { root, paths } = panel();
      try {
        expect(vhostTemplateExists(paths, "WordPress")).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

// The Instatic action adopts a matching pre-existing reverse-proxy site rather
// than failing, and keeps its own site_created=0 precisely so its cleanup
// never deletes a site that was already serving something. The Stager
// delegates the whole reverse-proxy create to it and used to set
// SITE_CREATED=1 on a zero exit, which threw that answer away twice:
// SITE_CREATED is the only guard on the panel write, and the rollback deleted
// through the same flag.
//
// The answer now crosses in the reply, so the field name is a contract between
// two files that cannot import each other -- which is the thing a test has to
// hold.
describe("a site the job adopted is not a site the job created", () => {
  const stager = () => readFileSync(join(repo, "addons/stager/action.ts"), "utf-8");
  const instatic = () => readFileSync(join(repo, "addons/instatic/action.ts"), "utf-8");

  test("the instatic create reply carries the created-or-adopted answer", () => {
    const src = instatic();
    const createReply = src.slice(src.indexOf("async function cmdCreate"));
    expect(createReply.slice(0, createReply.indexOf("\nasync function cmdUpdate")))
      .toInclude("siteCreatedByAddon: siteCreated");
  });

  test("the stager reads that field rather than trusting the exit status", () => {
    const src = stager();
    expect(src).toInclude("created.data?.siteCreatedByAddon === true");
    const from = src.indexOf("const created = callInstatic");
    const region = src.slice(from, src.indexOf("if (ctx.templateName)", from));
    const field = region.indexOf("created.data?.siteCreatedByAddon === true");
    expect(field).toBeGreaterThanOrEqual(0);
    expect(region.indexOf("ctx.siteCreated = true")).toBeGreaterThan(field);
  });

  // The two unwind questions are separate, because an Instatic clone can have
  // created the instance while adopting the site: that action refuses outright
  // if the container or meta.json already exist, so the container and the data
  // directory are always the job's, and its own delete leaves an adopted site
  // alone while removing them.
  describe("the unwind", () => {
    const unwind = (flags: { siteViaInstatic: boolean; siteCreated: boolean }): string[] => {
      const root = mkdtempSync(join(tmpdir(), "clp-stager-unwind-"));
      try {
        const calls = join(root, "calls");
        writeFileSync(calls, "");
        const shim = (name: string, reply: string) => {
          writeFileSync(join(root, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${reply}`, { mode: 0o755 });
          return join(root, name);
        };
        const ctx = newRunContext("20260910T120000Z-abcdef", root, testPaths(root, {
          clpctl: shim("clpctl", ""),
          actionBinary: shim("clp-addons", "echo '{\"ok\":true}'\n"),
        }));
        ctx.target = "stg.example.test";
        Object.assign(ctx, flags);
        rollbackRun(ctx);
        return readFileSync(calls, "utf8").split("\n").filter(Boolean);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    const instaticDelete = "clp-addons action instatic delete --domain stg.example.test --confirm stg.example.test";

    test("removes the instance through Instatic, whose own delete keeps an adopted site", () => {
      expect(unwind({ siteViaInstatic: true, siteCreated: false })).toEqual([instaticDelete]);
      expect(unwind({ siteViaInstatic: true, siteCreated: true })).toEqual([instaticDelete]);
    });

    test("deletes a site only when the job created it", () => {
      expect(unwind({ siteViaInstatic: false, siteCreated: true }))
        .toEqual(["clpctl site:delete --domainName=stg.example.test --force"]);
      expect(unwind({ siteViaInstatic: false, siteCreated: false })).toEqual([]);
    });
  });

  // And the window cmdClone leaves open when it drops the lock before handing
  // the work to systemd is closed where the work actually starts.
  test("the run verb re-checks that the target does not already exist", () => {
    const root = mkdtempSync(join(tmpdir(), "clp-stager-action-test-"));
    try {
      const paths = testPaths(root);
      const db = new Database(paths.panelDb);
      db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, user TEXT)");
      db.query("INSERT INTO site (domain_name, type, user) VALUES (?, ?, ?)").run("stg.example.test", "php", "stg");
      db.close();
      const id = "20260910T120000Z-abcdef";
      const dir = join(paths.jobsDir, id);
      writeJob(dir, { source: "live.example.test", target: "stg.example.test", state: "queued", step: "queued" });
      expect(() => runAction(paths, ["run", "--job", id], IDENTITY_STUB)).toThrow();
      expect(readFileSync(join(dir, "state"), "utf8").trim()).toBe("failed");
      expect(readFileSync(join(dir, "error"), "utf8"))
        .toContain("a CloudPanel site for stg.example.test appeared after this clone was queued; nothing was changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a .env the clone cannot repoint fails it", () => {
  expect(dotenvProblem("DB_DATABASE=a\nDB_USERNAME=b\nDB_PASSWORD=c\n")).toBeNull();
  expect(dotenvProblem("DB_DATABASE=a\nDB_USERNAME=b\nDB_PASSWORD=c\nDATABASE_URL=mysql://live\n")).toContain("database URL");
  expect(dotenvProblem("DB_DATABASE=a\n")).toContain("DB_USERNAME, DB_PASSWORD");
  const exported = "export DB_DATABASE=live\nexport DB_USERNAME=live\n  DB_PASSWORD = secret\nAPP_KEY=x\n";
  expect(dotenvProblem(exported)).toBeNull();
  expect(rewriteDotenvContent(exported, { name: "stg", user: "stg_u", pass: "p$&1" }))
    .toBe("export DB_DATABASE=stg\nexport DB_USERNAME=stg_u\n  DB_PASSWORD=p$&1\nAPP_KEY=x\n");
});

describe("the clone's wp-config.php", () => {
  const db = { name: "stg_db", user: "stg_user", pass: "s3cret" };

  test("is pointed at the clone's database whatever quotes and spacing it uses", () => {
    const rewritten = rewriteWpConfig([
      `define( 'DB_NAME', 'live_db' );`,
      `define("DB_USER","live_user");`,
      `define(\t'DB_PASSWORD' ,\t"p'a\\"ss" ) ;`,
    ].join("\n"), "stg.example.test", db);
    expect(rewritten).not.toContain("live_");
    expect(rewritten).toContain(`define( 'DB_NAME', 'stg_db' );`);
    expect(rewritten).toContain(`define( 'DB_USER', 'stg_user' );`);
    expect(rewritten).toContain(`define( 'DB_PASSWORD', 's3cret' );`);
    expect(rewritten).toContain(`define( 'WP_HOME', 'https://stg.example.test' );`);
  });

  test("fails rather than keep a credential it cannot rewrite", () => {
    expect(() => rewriteWpConfig([
      `define( 'DB_NAME', getenv('DB_NAME') );`,
      `define( 'DB_USER', 'live_user' );`,
      `define( 'DB_PASSWORD', 'x' );`,
    ].join("\n"), "stg.example.test", db)).toThrow("DB_NAME");
    expect(() => rewriteWpConfig(`define( 'DB_NAME', 'a' );`, "stg.example.test", db)).toThrow("DB_USER");
  });

  test("writes a password with replacement patterns in it literally", () => {
    const rewritten = rewriteWpConfig(
      `define('DB_NAME','a');define('DB_USER','b');define('DB_PASSWORD','c');`,
      "stg.example.test", { ...db, pass: "x$&y$1" },
    );
    expect(rewritten).toContain(`'x$&y$1'`);
  });
});
