import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applicationOk } from "../addons/stager/action";
import { expandTarget } from "../addons/stager/app/service";

const repo = join(import.meta.dir, "..");

function runAction(paths: Record<string, string>, argv: string[], prelude = ""): string {
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

test("manual stager prune keeps its exact JSON stdout reply", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-stager-action-test-"));
  const jobsDir = join(root, "jobs");
  const vhostsDir = join(root, "vhosts");
  const tempDir = join(root, "tmp");
  mkdirSync(vhostsDir);
  mkdirSync(tempDir);
  try {
    const prelude = `
      import { mock } from "bun:test";
      mock.module("./cli/action-common.ts", async () => {
        const real = await import("./cli/action-common.ts?manual-prune-contract");
        return { ...real, readPanelIdentity: () => ({ primary: "panel.example.test", aliases: [] }) };
      });
    `;
    const output = runAction({
      jobsDir,
      lockDir: join(root, "locks"),
      nginxVhostDir: vhostsDir,
      tempDir,
    }, ["prune"], prelude);
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

  // The predicate is not the whole answer, and this is the half that would
  // survive someone adding a caller that forgets to call it. The write
  // statement may not contain the application as text: it enters through
  // readfile(), the same way the nginx body does.
  const panelUpdateSite = () => {
    const src = readFileSync(join(repo, "addons/stager/action.ts"), "utf-8");
    const stmt = src.slice(src.indexOf("function panelUpdateSite"));
    return stmt.slice(0, stmt.indexOf("\n}\n") + 2);
  };

  test("the panel write never interpolates the application name", () => {
    const sql = panelUpdateSite().slice(panelUpdateSite().indexOf("const setVhost"));
    expect(sql).not.toInclude("${application}");
    expect(sql).toInclude("readfile(${sqlLiteral(appFile)})");
  });

  test("the read-back is a native parameterized query, not more shell SQL", () => {
    const body = panelUpdateSite();
    expect(body).toInclude("const check = queryPanel(ctx.paths");
    expect(body).toInclude("SELECT application, vhost_template FROM site WHERE domain_name = ? AND type = ?;");
  });

  // vhost_template_exists put the same value in a query and doubled the quotes
  // in it, which is sanitizing rather than rejecting. It must now refuse.
  describe("the template-exists lookup", () => {
    const existsSource = () => {
      const src = readFileSync(join(repo, "addons/stager/action.ts"), "utf-8");
      return src.slice(src.indexOf("function vhostTemplateExists"));
    };

    test("a name that fails the predicate is reported missing, not escaped", () => {
      expect(applicationOk("Generic', user = 'root")).toBe(false);
      const src = existsSource();
      expect(src.indexOf("if (!applicationOk(name)) return false;")).toBeLessThan(src.indexOf("queryPanel"));
    });

    test("a legitimate name is still queried", () => {
      expect(existsSource())
        .toInclude('db.query("SELECT COUNT(*) AS count FROM vhost_template WHERE name = ?;")');
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

  // The reader itself, driven over a reply of the shape the action emits.
  describe("reading the reply", () => {
    const CREATED = '{"ok":true,"data":{"domain":"stg.demo.test","port":39001,"tag":"0.0.18",'
      + '"container":"instatic-stg","siteUser":"addon-stgdemot-abc123","siteCreatedByAddon":true,"status":"running"}}';
    const ADOPTED = CREATED.replace('true,"status', 'false,"status');

    function read(json: string, field: string): string {
      try {
        const value = (JSON.parse(json) as { data?: Record<string, unknown> }).data?.[field];
        return value === undefined ? "" : String(value);
      } catch {
        return "";
      }
    }

    test("a created site reads as true and an adopted one as false", () => {
      expect(read(CREATED, "siteCreatedByAddon")).toBe("true");
      expect(read(ADOPTED, "siteCreatedByAddon")).toBe("false");
    });

    test("a reply without the field reads as nothing, which is not true", () => {
      expect(read('{"ok":true,"data":{"domain":"x"}}', "siteCreatedByAddon")).toBe("");
    });

    test("the port still reads out of the same helper", () => {
      expect(read(CREATED, "port")).toBe("39001");
    });
  });

  // The two unwind questions are separate, because an Instatic clone can have
  // created the instance while adopting the site: that action refuses outright
  // if the container or meta.json already exist, so the container and the data
  // directory are always the job's, and its own delete leaves an adopted site
  // alone while removing them.
  test("the instatic unwind is keyed on the instance, not on the site", () => {
    const src = stager();
    const rollback = src.slice(src.indexOf("function rollbackRun"));
    const unwind = rollback.slice(0, rollback.indexOf("\nfunction newRunContext"));
    expect(unwind).toInclude("else if (ctx.siteCreated)");
    expect(unwind.indexOf("if (ctx.siteViaInstatic)")).toBeLessThan(unwind.indexOf("else if (ctx.siteCreated)"));
  });

  // And the window cmdClone leaves open when it drops the lock before handing
  // the work to systemd is closed where the work actually starts.
  test("the run verb re-checks that the target does not already exist", () => {
    expect(stager()).toMatch(/if \(siteExists\(paths, ctx\.target\)\) \{\n\s*failJob/);
  });
});
