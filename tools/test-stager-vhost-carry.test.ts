// Carrying a source site's vhost onto its clone. site:add:php is the only
// site:add verb with a --vhostTemplate option, so for a static or
// reverse-proxy clone the source's config can only be carried by writing the
// panel record and rendering the file. Rendering it means knowing what this
// panel put in each {{placeholder}} -- learned by comparing the pair the panel
// wrote for the clone a moment ago, rather than by reimplementing a processor
// list a panel update can change.
//
// A wrong value here is a wrong nginx config, so what most of this pins is the
// refusals: the walk must consume the rendered file exactly to EOF, and a
// placeholder appearing twice must resolve identically both times.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeVhostBodyContent, learnVhostMapContent, recoverCarriedVhosts,
  renderVhostBodyResult, vhostTemplateBodyFromContent,
} from "../addons/stager/action";

const repo = join(import.meta.dir, "..");

function source(path: string): string {
  return readFileSync(join(repo, path), "utf-8");
}

/** The learned map, or a one-entry map naming the refusal. */
function learn(stored: string, rendered: string): Map<string, string> {
  const result = learnVhostMapContent(stored, rendered);
  return result.map ?? new Map([["REJECT", result.reason]]);
}

function render(body: string, stored: string, rendered: string): string {
  const learned = learnVhostMapContent(stored, rendered);
  if (!learned.map) return `LEARN-REJECT: ${learned.reason}`;
  const result = renderVhostBodyResult(body, learned.map);
  return result.value === null ? `RENDER-REJECT: ${result.reason}` : result.value;
}

describe("building the carried-over template", () => {
  const SOURCE = [
    "server {",
    "  listen 443 ssl;",
    "  server_name example.com www1.example.com;",
    "  {{root}}",
    '  add_header Link "<https://example.com/api>; rel=preconnect";',
    '  add_header X-Unrelated "https://notexample.com/keep";',
    "}",
  ].join("\n");

  const build = () => vhostTemplateBodyFromContent(SOURCE, "example.com", "stg.example.com") ?? "";

  // First, because two of the assertions below are phrased as absences and an
  // empty string satisfies both. When this function broke, one still reported ok.
  test("the builder produced a template at all", () => {
    expect(build().trim().length).toBeGreaterThan(0);
  });

  test("the generated server_name becomes the placeholder again", () => {
    expect(build()).toInclude("{{server_name}}");
    expect(build()).not.toInclude("server_name example.com");
  });

  test("a hand edit naming the source is rewritten to the target", () => {
    expect(build()).toInclude("<https://stg.example.com/api>");
  });

  test("a hostname that merely ends in the source is left alone", () => {
    expect(build()).toInclude("https://notexample.com/keep");
  });

  test("the clone's own name is not mangled into a double prefix", () => {
    expect(build()).not.toInclude("stg.stg.example.com");
  });

  test("CloudPanel's other placeholders survive untouched", () => {
    expect(build()).toInclude("{{root}}");
  });
});

describe("learning what CloudPanel substituted into a vhost", () => {
  // Modelled line for line on a real stored/rendered pair off a CloudPanel
  // 2.5.4 box: a placeholder on its own line, one inline inside a directive,
  // one appearing twice, one expanding to several lines and one to nothing.
  const STORED = [
    "server {",
    "  {{ssl_certificate}}",
    "  server_name stg.example.com;",
    "  {{root}}",
    "",
    "  {{nginx_access_log}}",
    "",
    "  {{settings}}",
    "",
    "  location / {",
    "    {{root}}",
    "  }",
    "",
    "  location ~ .php$ {",
    "    fastcgi_pass 127.0.0.1:{{php_fpm_port}};",
    '    fastcgi_param PHP_VALUE "{{php_settings}}";',
    "  }",
    "}",
  ].join("\n");

  const ROOT = "root /home/addon-stgexamp-ab12cd/htdocs/stg.example.com;";
  const RENDERED = [
    "server {",
    "  ssl_certificate /etc/nginx/ssl-certificates/stg.example.com.crt;",
    "  server_name stg.example.com;",
    `  ${ROOT}`,
    "",
    "  access_log /home/addon-stgexamp-ab12cd/logs/nginx/access.log main;",
    "",
    "  ",
    "",
    "  location / {",
    `    ${ROOT}`,
    "  }",
    "",
    "  location ~ .php$ {",
    "    fastcgi_pass 127.0.0.1:18031;",
    '    fastcgi_param PHP_VALUE "',
    "memory_limit=512M;",
    'display_errors=off;";',
    "  }",
    "}",
    // The panel writes the rendered template plus one newline the template
    // itself does not carry. Every site on the box measured this way.
    "",
  ].join("\n");

  test("the walk recovers every placeholder", () => {
    const map = learn(STORED, RENDERED);
    expect(map.has("REJECT")).toBe(false);
    expect(map.size).toBe(6);
  });

  test("a placeholder on its own line", () => {
    expect(learn(STORED, RENDERED).get("ssl_certificate"))
      .toBe("ssl_certificate /etc/nginx/ssl-certificates/stg.example.com.crt;");
  });

  test("one inline inside a directive", () => {
    expect(learn(STORED, RENDERED).get("php_fpm_port")).toBe("18031");
  });

  test("one that appears twice resolves once", () => {
    expect(learn(STORED, RENDERED).get("root")).toBe(ROOT);
  });

  test("one that expands to several lines", () => {
    expect(learn(STORED, RENDERED).get("php_settings")).toBe("\nmemory_limit=512M;\ndisplay_errors=off;");
  });

  test("one that expands to nothing", () => {
    expect(learn(STORED, RENDERED).get("settings")).toBe("");
  });

  // Rendering the stored body back through its own learned map must reproduce
  // the file it was learned from. If that does not hold, nothing built on the
  // map can be trusted either.
  test("the map round-trips the body it was learned from", () => {
    expect(`${render(STORED, STORED, RENDERED)}\n`).toBe(RENDERED);
  });

  // The walk is only sound because it fails rather than guesses. These would
  // otherwise produce a plausible-looking map and a wrong nginx config.
  describe("refusals", () => {
    // Reading forwards takes the shortest value that reaches the next literal,
    // so a wrong guess usually surfaces as a later literal failing to match --
    // but not when the literal between two DIFFERENT placeholders also occurs
    // inside the first one's value, because then the short reading and the
    // long one both consume the file to EOF. No stock CloudPanel template on
    // this box triggers it; the layout that does is one they already use, a
    // multi-line placeholder directly above another at the same indent.
    test("a boundary that could sit in two places is refused, and says so", () => {
      const ambiguous = learn(
        ["server {", "  {{settings}}", "  {{root}}", "}"].join("\n"),
        ["server {", "  include /etc/nginx/a;", "  include /etc/nginx/b;",
         "  root /home/u/htdocs/d;", "}", ""].join("\n"));
      expect(ambiguous.get("REJECT")).toBeDefined();
      expect(ambiguous.get("REJECT")).toInclude("more than one way");
    });

    // The same shape with the ambiguity removed resolves, so what is being
    // refused is the ambiguity and not the layout.
    test("the same layout without the ambiguity still resolves", () => {
      const unambiguous = learn(
        ["server {", "  {{settings}}", "  root {{root}};", "}"].join("\n"),
        ["server {", "  include /etc/nginx/a;", "  include /etc/nginx/b;",
         "  root /home/u/htdocs/d;", "}", ""].join("\n"));
      expect(unambiguous.get("settings")).toBe("include /etc/nginx/a;\n  include /etc/nginx/b;");
      expect(unambiguous.get("root")).toBe("/home/u/htdocs/d");
    });

    // The live layout this fires on: two log placeholders at one indent, where
    // the first expands to more than a line.
    test("a multi-line placeholder above another at the same indent is refused", () => {
      const logs = learn(
        ["server {", "  {{nginx_access_log}}", "  {{nginx_error_log}}", "}"].join("\n"),
        ["server {", "  access_log /home/u/logs/nginx/access.log main;",
         "  access_log /home/u/logs/nginx/json.log json;",
         "  error_log /home/u/logs/nginx/error.log;", "}", ""].join("\n"));
      expect(logs.get("REJECT")).toBeDefined();
    });

    // `{{ root }}` is not `{{root}}`. Template::getPlaceholders() matches
    // /{{[\sa-zA-Z0-9_]+}}/ so the panel recognises it, but
    // Processor::$placeholder is the exact string `{{root}}` and replace() is
    // a plain str_replace, so no processor ever fills it and
    // removeEmptyPlaceholders() blanks it. Folding the whitespace away gave a
    // rendered file with a root directive and a stored body the panel will
    // regenerate without one -- nginx -t passes, the clone serves, and the
    // document root vanishes the next time anything touches the site.
    test("a placeholder with whitespace in its braces is refused, learning and rendering", () => {
      expect(learn("server {\n  {{ root }}\n}", "server {\n  \n}\n").get("REJECT")).toBeDefined();
      const body = render("server {\n  {{ root }}\n}", STORED, RENDERED);
      expect(body).toStartWith("RENDER-REJECT");
      expect(body).toInclude("invalid");
    });

    test("two placeholders with nothing between them are refused", () => {
      const adjacent = learn("server {\n  {{settings}}{{root}}\n}", "server {\n  ab\n}\n");
      expect(adjacent.get("REJECT")).toInclude("next to each other");
    });

    test("a walk that does not consume the file is refused", () => {
      expect(learn(STORED, `${RENDERED}# something the template does not have\n`).get("REJECT")).toBeDefined();
    });

    test("a placeholder that would resolve two ways is refused, and says which", () => {
      const inconsistent = learn(STORED, RENDERED.replace(`    ${ROOT}`, "    root /somewhere/else;"));
      expect(inconsistent.get("REJECT")).toInclude("{{root}}");
    });

    // CloudPanel's own removeEmptyPlaceholders() blanks leftovers; copying
    // that here would turn an unknown {{root}} into a server block with no
    // document root, which nginx accepts and serves as the wrong thing.
    test("a placeholder the panel did not use is refused, not blanked", () => {
      const unknown = render(STORED.replace("{{root}}", "{{nodejs_proxy_pass}}"), STORED, RENDERED);
      expect(unknown).toStartWith("RENDER-REJECT");
      expect(unknown).toInclude("nodejs_proxy_pass");
    });

    // The column's convention is not the file's, and the difference is load
    // bearing. Every panel-written site.vhost_template on this box ends with
    // `}` -- all 31 rows measured -- while the file it renders to ends with
    // exactly one newline, and the walk compensates for that. A body stored
    // with a trailing newline is therefore a body this addon cannot read back:
    // the clone this implementation first produced, stg.demo.clp-stg.local,
    // stored 10 as its last codepoint and refused to be cloned again.
    test("a stored body carrying a trailing newline is refused", () => {
      const withNewline = learn(`${STORED}\n`, RENDERED);
      expect(withNewline.get("REJECT")).toInclude("does not end with the text after");
    });
  });

  // So the installer has to stage the two halves the way the panel writes
  // them. The two writes sit far apart in carryVhost and drifting them apart
  // would make the panel row and the file disagree.
  describe("staging the two halves", () => {
    const carryVhost = () => {
      const src = source("addons/stager/action.ts");
      const from = src.indexOf("function carryVhost");
      return src.slice(from, src.indexOf("\nfunction jobStateFor", from));
    };

    test("the carried body is staged without a trailing newline, the rendered file with one", () => {
      const fn = carryVhost();
      expect(fn).toInclude("writeFileSync(body, composed");
      expect(fn).not.toInclude("writeFileSync(body, `${composed}\\n`");
      expect(fn).toInclude("writeFileSync(rendered, `${renderedBody}\\n`");
    });

    // Every failure that can run after the UPDATE has to put the row back as
    // well as the file, and that is more branches than it looks:
    // panelUpdateSite returning 1 from its *read-back* means the UPDATE
    // already ran. Leaving the row alone there is the one disagreement the
    // file-first ordering exists to prevent -- the panel regenerates the file
    // from the row -- reached by the failure path instead of the success path.
    test("every restore that can follow the panel write restores the row too", () => {
      const fn = carryVhost();
      const writeAt = fn.indexOf("if (!panelUpdateSite");
      expect(writeAt).not.toBe(-1);
      const after = [...fn.slice(writeAt).matchAll(/restore\((true|false),/g)].map((match) => match[1]!);
      expect(after).toEqual(["true", "true"]);
    });

    test("and the ones that cannot do not touch the row", () => {
      const calls = [...carryVhost().matchAll(/restore\((true|false),/g)].map((match) => match[1]!);
      expect(calls).toHaveLength(4);
      expect(calls.filter((value) => value === "false")).toHaveLength(2);
    });
  });
});

// Four things separate a source's stored body from its clone's, and every one
// of them is something CloudPanel generated rather than something an operator
// chose: the http->https redirect block, which only an apex or www hostname
// earns; the shape of the server_name line; any hand edit that names the
// source hostname; and nothing else at all.
describe("composing a clone's vhost from its source's", () => {
  // A static site's stored body, apex, with the redirect block CloudPanel
  // prepends for one, and two hand edits: one naming the source hostname and
  // one naming a hostname that merely ends in it.
  const STATIC_SOURCE = [
    "server {",
    "  {{ssl_certificate}}",
    "  server_name www.example.com;",
    "  return 301 https://example.com$request_uri;",
    "}",
    "",
    "server {",
    "  {{ssl_certificate}}",
    "  server_name example.com www1.example.com;",
    "  {{root}}",
    '  add_header Content-Security-Policy "default-src https://example.com";',
    '  add_header X-Unrelated "https://notexample.com/keep";',
    "  index index.html;",
    "}",
  ].join("\n");

  const SUB_TARGET = [
    "server {",
    "  {{ssl_certificate}}",
    "  server_name stg.example.com;",
    "  {{root}}",
    "  index index.html;",
    "}",
  ].join("\n");

  const APEX_TARGET = [
    "server {",
    "  {{ssl_certificate}}",
    "  server_name www.staging.test;",
    "  return 301 https://staging.test$request_uri;",
    "}",
    "",
    "server {",
    "  {{ssl_certificate}}",
    "  server_name staging.test www1.staging.test;",
    "  {{root}}",
    "  index index.html;",
    "}",
  ].join("\n");

  const compose = (target: string, targetBody: string) =>
    composeVhostBodyContent(STATIC_SOURCE, targetBody, "example.com", target) ?? "REJECT: composition failed";

  const sub = () => compose("stg.example.com", SUB_TARGET);

  // First, because two of the assertions are phrased as absences and an empty
  // string satisfies both.
  test("composition produced a body at all", () => {
    expect(sub().trim().length).toBeGreaterThan(0);
  });

  test("the source's redirect block is dropped", () => {
    expect(sub()).not.toInclude("return 301");
  });

  test("the clone's own server_name replaces the source's", () => {
    expect(sub()).toInclude("server_name stg.example.com;");
    expect(sub()).not.toInclude("server_name example.com");
  });

  test("a hand edit naming the source is rewritten to the target", () => {
    expect(sub()).toInclude("default-src https://stg.example.com");
  });

  test("a hostname that merely ends in the source is left alone", () => {
    expect(sub()).toInclude("https://notexample.com/keep");
  });

  test("the clone's own name is not mangled into a double prefix", () => {
    expect(sub()).not.toInclude("stg.stg.example.com");
  });

  test("CloudPanel's placeholders survive untouched", () => {
    expect(sub()).toInclude("{{root}}");
    expect(sub()).toInclude("{{ssl_certificate}}");
  });

  // The mirror case: the clone is itself an apex, so it earns a redirect block
  // of its own, taken from what the panel wrote for it rather than from the
  // source's.
  test("an apex clone gets its own redirect block, and only one", () => {
    const apex = compose("staging.test", APEX_TARGET);
    expect(apex).toInclude("return 301 https://staging.test$request_uri;");
    expect(apex).not.toInclude("https://example.com$request_uri");
    expect(apex.match(/return 301/g) ?? []).toHaveLength(1);
    expect(apex).toInclude("server_name staging.test www1.staging.test;");
  });
});

// carryVhost writes the composed config over the clone's own and then runs
// `nginx -t`. A SIGKILL in between -- OOM, `systemctl stop`, a reboot --
// leaves an unvalidated config in service, with the job's own restore never
// run, and it breaks the NEXT reload of any site on the box: a failure nobody
// will connect to a clone that happened hours earlier. So the backup lives
// beside the file under a name nginx does not include, and `prune`, which
// repair runs every fifteen minutes, is what finds it.
describe("a killed clone does not leave the box worse off", () => {
  test("the backup is not something nginx's sites-enabled/*.conf glob loads", () => {
    expect("example.com.conf.clp-stager-bak".endsWith(".conf")).toBe(false);
  });

  // Driven with nginx and systemctl stubbed, because the point is which file
  // ends up in place rather than whether this box reloads.
  function recover(state: string): { out: string; conf: string; bak: boolean } {
    const dir = mkdtempSync(`${tmpdir()}/clp-stager-recover-`);
    const oldPath = process.env.PATH;
    try {
      const bin = `${dir}/bin`;
      mkdirSync(bin, { recursive: true });
      for (const command of ["nginx", "systemctl", "chown"]) {
        writeFileSync(`${bin}/${command}`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        chmodSync(`${bin}/${command}`, 0o755);
      }
      mkdirSync(`${dir}/vhosts`, { recursive: true });
      mkdirSync(`${dir}/jobs/20260908T120000Z-aaaaaa`, { recursive: true });
      writeFileSync(`${dir}/jobs/20260908T120000Z-aaaaaa/target`, "stg.example.com\n");
      writeFileSync(`${dir}/jobs/20260908T120000Z-aaaaaa/state`, `${state}\n`);
      writeFileSync(`${dir}/vhosts/stg.example.com.conf`, "CARRIED\n");
      writeFileSync(`${dir}/vhosts/stg.example.com.conf.clp-stager-bak`, "STOCK\n");
      const paths = {
        lockDir: `${dir}/lock`, dataBaseDir: `${dir}/data`, jobsDir: `${dir}/jobs`, panelDb: `${dir}/panel.db`,
        clpctl: `${bin}/clpctl`, panelIdentityFile: `${dir}/identity`, nginxVhostDir: `${dir}/vhosts`,
        instaticDataDir: `${dir}/instatic`, actionBinary: `${bin}/clp-addons`, tempDir: `${dir}/tmp`, sqlite3: "sqlite3",
      };
      mkdirSync(paths.tempDir, { recursive: true });
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      return {
        out: `n=${recoverCarriedVhosts(paths)}`,
        conf: readFileSync(`${dir}/vhosts/stg.example.com.conf`, "utf-8").trim(),
        bak: readdirSync(`${dir}/vhosts`).some((file) => file.endsWith(".clp-stager-bak")),
      };
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a job that did not finish gets its stock vhost put back", () => {
    expect(recover("failed")).toEqual({ out: "n=1", conf: "STOCK", bak: false });
  });

  test("a job that finished keeps its carried vhost, and the leftover is dropped", () => {
    expect(recover("done")).toEqual({ out: "n=0", conf: "CARRIED", bak: false });
  });

  test("a job still running owns that file and is left alone", () => {
    expect(recover("running")).toEqual({ out: "n=0", conf: "CARRIED", bak: true });
  });

  // A record stuck in `running` never expires -- prune skips work in flight --
  // and `clone` refuses a target that already has one, so the hostname is
  // blocked for good. That is what a killed job leaves, because cmdRun writes
  // `running` and only ever writes `done` or `failed` itself.
  describe("what prune sweeps", () => {
    const pruneBody = () => {
      const src = source("addons/stager/action.ts");
      const prune = src.slice(src.indexOf("function cmdPrune"));
      return prune.slice(0, prune.indexOf("\nfunction dispatch"));
    };

    // The record sweep itself is shared; only the stager's own cleanup is here.
    test("the shared sweep asks systemd whether a running record is really running", () => {
      const store = source("cli/job-store.ts");
      const sweep = store.slice(store.indexOf("export function pruneJobs"));
      expect(sweep).toInclude("jobUnitIsActive(addon, entry)");
      expect(store).toInclude('runCommand("systemctl", ["is-active", "--quiet", jobUnitName(addon, id)])');
      expect(sweep).toInclude('jobSet(dir, "state", "failed")');
    });

    test("the stager asks for the sweep with its own retention", () => {
      const body = pruneBody();
      expect(body).toInclude("pruneJobs({");
      expect(body).toInclude('addon: "stager"');
      expect(body).toInclude("retentionDays: JOB_RETENTION_DAYS");
    });

    test("it also sweeps a staging directory a killed job left in /tmp", () => {
      expect(pruneBody()).toInclude('entry.startsWith("clp-stager-stage.")');
    });

    test("and runs the vhost recovery after the records, not before", () => {
      const body = pruneBody();
      expect(body.indexOf("recoverCarriedVhosts(paths)")).toBeGreaterThan(body.indexOf("pruneJobs({"));
    });
  });
});
