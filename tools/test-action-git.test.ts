// The Git addon's action, against a real repository.
//
// A temporary bare repository stands in for the remote and a temporary tree
// stands in for the site, so the deployment that runs here is the one that runs
// on a CloudPanel box: git init, fetch, reset, post-deploy command. The two
// overrides are the two things a test cannot be: `runuser` becomes a shim that
// runs the command as whoever is running the test, and the remote validator
// accepts a local path, which the installed addon deliberately refuses.

import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  runGitAction, validateBranch, validateDirectory, validatePostDeploy, validateRemote, WEBHOOK_TOKEN_RE,
} from "../addons/git/action";
import { ActionFailure } from "../cli/action-common";

const DOMAIN = "app.example.test";
const USER = userInfo().username;
const originalPath = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = originalPath;
});

interface Fixture {
  root: string;
  options: Parameters<typeof runGitAction>[1];
  siteDir: string;
  bare: string;
  work: string;
  jobsDir: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "clp-git-action-"));

  // `runuser -u <user> -- <command...>`, without the privilege drop a test
  // cannot make: the three leading arguments are dropped and the rest is run.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "runuser");
  writeFileSync(shim, "#!/bin/sh\nshift 3\nexec \"$@\"\n");
  chmodSync(shim, 0o755);

  // `deploy` and a webhook delivery hand the work to systemd, which a test has
  // no business starting. The shim accepts the unit and runs nothing, so the
  // job stays queued and what is asserted is what was enqueued.
  const systemdRun = join(bin, "systemd-run");
  writeFileSync(systemdRun, "#!/bin/sh\nexit 0\n");
  chmodSync(systemdRun, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;

  const panelDb = join(root, "panel.db");
  const db = new Database(panelDb, { create: true });
  db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, user TEXT)");
  db.query("INSERT INTO site (id, domain_name, type, user) VALUES (?, ?, ?, ?)").run(1, DOMAIN, "php", USER);
  db.close();

  const home = join(root, "home");
  const siteDir = join(home, USER, "htdocs", DOMAIN);
  mkdirSync(siteDir, { recursive: true });

  // The remote: a bare repository with one commit on `main`.
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "index.php"), "<?php echo 'one';\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "first commit");
  const bare = join(root, "remote.git");
  git(root, "clone", "-q", "--bare", work, bare);

  return {
    root,
    siteDir,
    bare,
    work,
    jobsDir: join(root, "state", "jobs"),
    options: {
      rootUid: 0,
      domainValidator: (value: string) => value.toLowerCase(),
      remoteValidator: (value: unknown) => String(value),
      paths: {
        dataDir: join(root, "state"),
        lockDir: join(root, "locks"),
        panelDb,
        homeDir: home,
        runuser: shim,
      },
    },
  };
}

/** Run one verb and return its JSON reply. */
async function action(
  fx: Fixture, argv: string[], input?: string,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as never;
  const errorWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as never;
  try {
    await runGitAction(argv, { ...fx.options, ...(input === undefined ? {} : { input }) });
  } finally {
    process.stdout.write = write;
    process.stderr.write = errorWrite;
  }
  return JSON.parse(chunks.join("").trim().split("\n").at(-1)!);
}

/** A queued deployment record, as `deploy` writes it before systemd takes over. */
function queueJob(fx: Fixture, id: string): string {
  const dir = join(fx.jobsDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [field, value] of [["kind", "deploy"], ["domain", DOMAIN], ["state", "queued"], ["step", "queued"]]) {
    writeFileSync(join(dir, field!), `${value}\n`, { mode: 0o600 });
  }
  writeFileSync(join(dir, "log"), "", { mode: 0o600 });
  return dir;
}

function field(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8").trim();
}

test("the remote, branch, directory and command validators refuse what they should", () => {
  const refused = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return error instanceof ActionFailure ? error.message : `unexpected: ${String(error)}`;
    }
    return "";
  };

  expect(validateRemote("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git");
  expect(validateRemote(" https://github.com/owner/repo.git ")).toBe("https://github.com/owner/repo.git");
  expect(validateRemote("ssh://git@github.com:22/owner/repo.git")).toBe("ssh://git@github.com:22/owner/repo.git");
  // A local path, a remote helper and a plain-text transport are all refused,
  // and so is a token pasted into an HTTPS URL.
  expect(refused(() => validateRemote("/srv/repo.git"))).toBeTruthy();
  expect(refused(() => validateRemote("file:///srv/repo.git"))).toBeTruthy();
  expect(refused(() => validateRemote("ext::sh -c whoami"))).toBeTruthy();
  expect(refused(() => validateRemote("http://github.com/owner/repo.git"))).toBeTruthy();
  expect(refused(() => validateRemote("https://user:token@github.com/owner/repo.git")))
    .toContain("deploy key");
  expect(refused(() => validateRemote("--upload-pack=touch /tmp/x"))).toBeTruthy();
  expect(refused(() => validateRemote("https://github.com/owner/../../etc"))).toBeTruthy();

  expect(validateBranch("release/2.1")).toBe("release/2.1");
  expect(refused(() => validateBranch("--force"))).toBeTruthy();
  expect(refused(() => validateBranch("a..b"))).toBeTruthy();
  expect(refused(() => validateBranch("feature.lock"))).toBeTruthy();

  expect(validateDirectory("/public/")).toBe("public");
  expect(validateDirectory(undefined)).toBe("");
  expect(refused(() => validateDirectory("../escape"))).toBeTruthy();
  expect(refused(() => validateDirectory("a/../b"))).toBeTruthy();

  expect(validatePostDeploy(" composer install ")).toBe("composer install");
  expect(refused(() => validatePostDeploy("a\nb"))).toBeTruthy();
});

test("configure stores one site's settings and status reads them back", async () => {
  const fx = fixture();
  try {
    const missing = await action(fx, ["status", `--domain=${DOMAIN}`]);
    expect(missing.ok).toBe(true);
    expect(missing.data.site.configured).toBe(false);
    expect(missing.data.site.siteUser).toBe(USER);
    expect(missing.data.site.path).toBe(fx.siteDir);

    const saved = await action(fx, ["configure", `--domain=${DOMAIN}`],
      JSON.stringify({ remote: fx.bare, branch: "main", directory: "public", postDeploy: "true" }));
    expect(saved.ok).toBe(true);
    expect(saved.data.site.config.branch).toBe("main");
    expect(saved.data.site.config.directory).toBe("public");
    expect(saved.data.site.path).toBe(join(fx.siteDir, "public"));

    const listed = await action(fx, ["sites"]);
    expect(listed.data.sites.map((site: { domain: string }) => site.domain)).toEqual([DOMAIN]);

    const forgotten = await action(fx, ["forget", `--domain=${DOMAIN}`]);
    expect(forgotten.ok).toBe(true);
    expect((await action(fx, ["sites"])).data.sites).toEqual([]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a deployment fetches the branch, checks it out and runs the post-deploy command", async () => {
  const fx = fixture();
  try {
    await action(fx, ["configure", `--domain=${DOMAIN}`], JSON.stringify({
      remote: fx.bare, branch: "main", directory: "", postDeploy: "echo ran > post-deploy.txt",
    }));

    const dir = queueJob(fx, "20260918T120000Z-aaaaaa");
    expect(await runGitAction(["run", "--job=20260918T120000Z-aaaaaa"], { ...fx.options, emitReply: false })).toBe(0);

    expect(field(dir, "state")).toBe("done");
    expect(readFileSync(join(fx.siteDir, "index.php"), "utf8")).toContain("one");
    expect(readFileSync(join(fx.siteDir, "post-deploy.txt"), "utf8").trim()).toBe("ran");
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    expect(result.postDeployRan).toBe(true);
    expect(result.commit.subject).toBe("first commit");
    expect(readFileSync(join(dir, "log"), "utf8")).toContain("deployment finished");

    // A second deployment moves the tree onto the new commit and leaves what
    // the site wrote for itself alone.
    writeFileSync(join(fx.siteDir, "uploads.txt"), "kept\n");
    writeFileSync(join(fx.work, "index.php"), "<?php echo 'two';\n");
    git(fx.work, "commit", "-qam", "second commit");
    git(fx.work, "push", "-q", fx.bare, "main");

    const second = queueJob(fx, "20260918T130000Z-bbbbbb");
    expect(await runGitAction(["run", "--job=20260918T130000Z-bbbbbb"], { ...fx.options, emitReply: false })).toBe(0);
    expect(field(second, "state")).toBe("done");
    expect(readFileSync(join(fx.siteDir, "index.php"), "utf8")).toContain("two");
    expect(readFileSync(join(fx.siteDir, "uploads.txt"), "utf8").trim()).toBe("kept");

    const status = await action(fx, ["status", `--domain=${DOMAIN}`]);
    expect(status.data.site.commit.subject).toBe("second commit");
    expect(status.data.site.lastJob.id).toBe("20260918T130000Z-bbbbbb");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a deployment into a subdirectory creates it and stays inside the site", async () => {
  const fx = fixture();
  try {
    await action(fx, ["configure", `--domain=${DOMAIN}`],
      JSON.stringify({ remote: fx.bare, branch: "main", directory: "releases/current", postDeploy: "" }));
    const dir = queueJob(fx, "20260918T140000Z-cccccc");
    expect(await runGitAction(["run", "--job=20260918T140000Z-cccccc"], { ...fx.options, emitReply: false })).toBe(0);
    expect(field(dir, "state")).toBe("done");
    expect(existsSync(join(fx.siteDir, "releases", "current", "index.php"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).postDeployRan).toBe(false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a branch the remote does not have fails the job and says so", async () => {
  const fx = fixture();
  try {
    await action(fx, ["configure", `--domain=${DOMAIN}`],
      JSON.stringify({ remote: fx.bare, branch: "no-such-branch", directory: "", postDeploy: "" }));
    const dir = queueJob(fx, "20260918T150000Z-dddddd");
    expect(await runGitAction(["run", "--job=20260918T150000Z-dddddd"], { ...fx.options, emitReply: false })).toBe(1);
    expect(field(dir, "state")).toBe("failed");
    expect(field(dir, "error")).toContain("could not fetch");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a failing post-deploy command fails the job with the files already deployed", async () => {
  const fx = fixture();
  try {
    await action(fx, ["configure", `--domain=${DOMAIN}`],
      JSON.stringify({ remote: fx.bare, branch: "main", directory: "", postDeploy: "exit 3" }));
    const dir = queueJob(fx, "20260918T160000Z-eeeeee");
    expect(await runGitAction(["run", "--job=20260918T160000Z-eeeeee"], { ...fx.options, emitReply: false })).toBe(1);
    expect(field(dir, "state")).toBe("failed");
    expect(field(dir, "error")).toContain("post-deploy command failed");
    expect(existsSync(join(fx.siteDir, "index.php"))).toBe(true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("the deploy key is generated as the site user and only its public half is reported", async () => {
  const fx = fixture();
  try {
    const generated = await action(fx, ["keygen", `--domain=${DOMAIN}`]);
    expect(generated.ok).toBe(true);
    expect(generated.data.publicKey).toStartWith("ssh-ed25519 ");
    expect(generated.data.publicKey).toContain(DOMAIN);

    const keyFile = join(fx.root, "home", USER, ".ssh", "clp-addons-deploy");
    expect(readFileSync(keyFile, "utf8")).toContain("OPENSSH PRIVATE KEY");

    // Asking again keeps the key that is already on the repository.
    const again = await action(fx, ["keygen", `--domain=${DOMAIN}`]);
    expect(again.data.publicKey).toBe(generated.data.publicKey);

    const replaced = await action(fx, ["keygen", `--domain=${DOMAIN}`, "--replace"]);
    expect(replaced.data.publicKey).not.toBe(generated.data.publicKey);

    const status = await action(fx, ["status", `--domain=${DOMAIN}`]);
    expect(status.data.site.publicKey).toBe(replaced.data.publicKey);
    // The private half is never part of a reply.
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("the action refuses a site CloudPanel does not have and an unknown argument", async () => {
  const fx = fixture();
  try {
    const unknownSite = await action(fx, ["status", "--domain=absent.example.test"]);
    expect(unknownSite.ok).toBe(false);
    expect(unknownSite.error).toContain("CloudPanel site not found");

    const unknownFlag = await action(fx, ["status", `--domain=${DOMAIN}`, "--force"]);
    expect(unknownFlag.ok).toBe(false);
    expect(unknownFlag.error).toContain("unknown argument");

    const undeployed = await action(fx, ["deploy", `--domain=${DOMAIN}`]);
    expect(undeployed.ok).toBe(false);
    expect(undeployed.error).toContain("no repository configured");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- push to deploy */

/** Configure the fixture's site and turn push-to-deploy on, returning its token. */
async function withWebhook(fx: Fixture, branch = "main"): Promise<string> {
  await action(fx, ["configure", `--domain=${DOMAIN}`],
    JSON.stringify({ remote: fx.bare, branch, directory: "", postDeploy: "" }));
  const enabled = await action(fx, ["webhook-enable", `--domain=${DOMAIN}`]);
  return enabled.data.webhook.token;
}

/** The record as it is on disk, which is the only place the token is kept. */
function storedWebhook(fx: Fixture): { token: string; lastDelivery: string; lastDeliveryAt: string; lastDeliveryJob: string } | null {
  return JSON.parse(readFileSync(join(fx.root, "state", "sites", `${DOMAIN}.json`), "utf8")).webhook ?? null;
}

test("the webhook token is minted, kept, rotated and invalidated", async () => {
  const fx = fixture();
  try {
    const token = await withWebhook(fx);
    expect(token).toMatch(WEBHOOK_TOKEN_RE);

    // Enabling again keeps the URL that is already in the repository.
    expect((await action(fx, ["webhook-enable", `--domain=${DOMAIN}`])).data.webhook.token).toBe(token);

    const rotated = (await action(fx, ["webhook-enable", `--domain=${DOMAIN}`, "--replace"])).data.webhook.token;
    expect(rotated).toMatch(WEBHOOK_TOKEN_RE);
    expect(rotated).not.toBe(token);

    // Saving the repository settings again does not revoke a live URL.
    await action(fx, ["configure", `--domain=${DOMAIN}`],
      JSON.stringify({ remote: fx.bare, branch: "main", directory: "", postDeploy: "true" }));
    expect(storedWebhook(fx)!.token).toBe(rotated);

    // The site's own page is given the token; the fleet page is not.
    expect((await action(fx, ["status", `--domain=${DOMAIN}`])).data.site.config.webhook.token).toBe(rotated);
    expect((await action(fx, ["sites"])).data.sites[0].config.webhook.token).toBe("");

    const off = await action(fx, ["webhook-disable", `--domain=${DOMAIN}`]);
    expect(off.ok).toBe(true);
    expect(storedWebhook(fx)).toBeNull();
    // A delivery to the old URL is now refused like any other stranger's.
    expect((await action(fx, ["hook", `--domain=${DOMAIN}`], JSON.stringify({ token: rotated }))).ok).toBe(false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a delivery is authenticated by its token and nothing else", async () => {
  const fx = fixture();
  try {
    const token = await withWebhook(fx);
    const deliver = (payload: Record<string, unknown>) =>
      action(fx, ["hook", `--domain=${DOMAIN}`], JSON.stringify(payload));

    // A token of another length must be refused by the length check rather
    // than crash the comparison, which is what timingSafeEqual does on one.
    expect((await deliver({ token: "short" })).ok).toBe(false);
    expect((await deliver({})).ok).toBe(false);
    // The right length and the wrong value: one character short of the token.
    const nearMiss = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    const wrong = await deliver({ token: nearMiss });
    expect(wrong.ok).toBe(false);
    // Nothing was queued and nothing was recorded for a delivery that failed
    // to authenticate: only the operator's own page may learn it happened.
    expect(storedWebhook(fx)!.lastDeliveryAt).toBe("");
    expect((await action(fx, ["jobs"])).data.jobs).toEqual([]);

    const accepted = await deliver({ token, ref: "refs/heads/main" });
    expect(accepted.ok).toBe(true);
    expect(accepted.data.deployed).toBe(true);
    expect(accepted.data.outcome).toBe("started a deployment");

    const job = (await action(fx, ["jobs"])).data.jobs[0];
    expect(job.id).toBe(accepted.data.job);
    expect(job.startedBy).toBe("push");
    expect(job.state).toBe("queued");
    expect(storedWebhook(fx)!.lastDeliveryJob).toBe(job.id);
    expect(storedWebhook(fx)!.lastDeliveryAt).not.toBe("");

    // The duplicate-job guard is what makes a redelivery a no-op.
    const replay = await deliver({ token, ref: "refs/heads/main" });
    expect(replay.ok).toBe(true);
    expect(replay.data.deployed).toBe(false);
    expect(replay.data.outcome).toContain("already queued");
    expect((await action(fx, ["jobs"])).data.jobs.length).toBe(1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a push for another branch, a ping and a bad signature are reported rather than deployed", async () => {
  const fx = fixture();
  try {
    const token = await withWebhook(fx);
    const deliver = (payload: Record<string, unknown>) =>
      action(fx, ["hook", `--domain=${DOMAIN}`], JSON.stringify(payload));

    const otherBranch = await deliver({ token, ref: "refs/heads/dev" });
    expect(otherBranch.data.deployed).toBe(false);
    expect(otherBranch.data.outcome).toContain("refs/heads/dev");
    expect(storedWebhook(fx)!.lastDelivery).toContain("refs/heads/dev");

    const ping = await deliver({ token, event: "ping" });
    expect(ping.data.deployed).toBe(false);
    expect(ping.data.outcome).toContain("ping");

    const body = JSON.stringify({ ref: "refs/heads/main" });
    const forged = await deliver({ token, ref: "refs/heads/main", body, signature: "sha256=0bad" });
    expect(forged.data.deployed).toBe(false);
    expect(forged.data.outcome).toContain("X-Hub-Signature-256");
    expect((await action(fx, ["jobs"])).data.jobs).toEqual([]);

    // The same payload signed with the token, which is the secret to use.
    const signature = `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
    const signed = await deliver({ token, ref: "refs/heads/main", body, signature });
    expect(signed.data.deployed).toBe(true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("push-to-deploy cannot be turned on for a site with no repository", async () => {
  const fx = fixture();
  try {
    const refused = await action(fx, ["webhook-enable", `--domain=${DOMAIN}`]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("no repository configured");
    expect((await action(fx, ["webhook-enable", "--domain=absent.example.test"])).ok).toBe(false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
