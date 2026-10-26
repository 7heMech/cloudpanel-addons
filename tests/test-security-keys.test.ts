// Passkey sign-in end to end against a software authenticator: registration,
// sign-in to CloudPanel's own one-time token, and every refusal that matters.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecurityKeysAction, type SecurityKeysPaths } from "../addons/security-keys/action";
import { SECURITY_KEYS_TARGETS } from "../addons/security-keys/inject/targets";
import { dashboardView } from "../addons/security-keys/app/views";
import { decodeCbor, verifyAssertion, verifyRegistration } from "../addons/security-keys/webauthn";

const ORIGIN = "https://panel.example.com:8443";
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;
const BE = 0x08;

function encodeCbor(value: unknown): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(length, 1);
    return out;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [encodeCbor(k), encodeCbor(v)])]);
  }
  throw new Error("unsupported");
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest();

class SoftKey {
  readonly id = randomBytes(16);
  readonly handle: { value: string | null } = { value: null };
  private readonly privateKey: KeyObject;
  private readonly cose: Map<number, number | Buffer>;
  counter = 0;

  constructor(readonly kind: "es256" | "ed25519" = "es256", readonly counting = true) {
    const pair = kind === "es256"
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.cose = kind === "es256"
      ? new Map<number, number | Buffer>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]])
      : new Map<number, number | Buffer>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, "base64url")]]);
  }

  private authData(origin: string, flags: number, withCredential: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha(new URL(origin).hostname), Buffer.from([flags]), count];
    if (withCredential) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.id.length);
      parts.push(Buffer.alloc(16), length, this.id, encodeCbor(this.cose));
    }
    return Buffer.concat(parts);
  }

  create(challenge: string, options: { origin?: string; flags?: number; rpOrigin?: string } = {}) {
    const origin = options.origin ?? ORIGIN;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin }));
    const authData = this.authData(options.rpOrigin ?? origin, options.flags ?? (UP | UV | AT), true);
    return { clientDataJSON, attestationObject: encodeCbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])) };
  }

  get(challenge: string, options: { origin?: string; flags?: number } = {}) {
    const origin = options.origin ?? ORIGIN;
    if (this.counting) this.counter += 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
    const authenticatorData = this.authData(origin, options.flags ?? (UP | UV), false);
    const signed = Buffer.concat([authenticatorData, sha(clientDataJSON)]);
    const signature = sign(this.kind === "es256" ? "sha256" : null, signed, this.privateKey);
    return { clientDataJSON, authenticatorData, signature };
  }
}

describe("the WebAuthn checks", () => {
  for (const kind of ["es256", "ed25519"] as const) {
    test(`a ${kind} key registers and then signs in`, () => {
      const key = new SoftKey(kind);
      const made = key.create("reg-challenge");
      const registration = verifyRegistration({ ...made, challenge: "reg-challenge" });
      expect(registration.credentialId).toBe(b64(key.id));
      expect(registration.origin).toBe(ORIGIN);
      const proof = key.get("login-challenge");
      expect(verifyAssertion({ ...proof, challenge: "login-challenge", origin: ORIGIN, publicKey: registration.publicKey, signCount: 0 }))
        .toEqual({ signCount: 1 });
    });
  }

  test("registration is refused without user verification, for another site, or on an IP address", () => {
    const key = new SoftKey();
    expect(() => verifyRegistration({ ...key.create("c", { flags: UP | AT }), challenge: "c" })).toThrow(/verify its user/);
    expect(() => verifyRegistration({ ...key.create("c", { rpOrigin: "https://evil.example" }), challenge: "c" })).toThrow(/different site/);
    expect(() => verifyRegistration({ ...key.create("c", { origin: "https://192.0.2.1:8443" }), challenge: "c" })).toThrow(/hostname/);
    expect(() => verifyRegistration({ ...key.create("c"), challenge: "other" })).toThrow(/challenge/);
  });

  test("an assertion is refused for the wrong challenge, origin, signature or a counter that went back", () => {
    const key = new SoftKey();
    const { publicKey } = verifyRegistration({ ...key.create("c"), challenge: "c" });
    const base = { origin: ORIGIN, publicKey, signCount: 0 };
    expect(() => verifyAssertion({ ...key.get("a"), ...base, challenge: "b" })).toThrow(/challenge/);
    expect(() => verifyAssertion({ ...key.get("a", { origin: "https://other.example.com" }), ...base, challenge: "a" })).toThrow(/different panel address/);
    expect(() => verifyAssertion({ ...key.get("a", { flags: UP }), ...base, challenge: "a" })).toThrow(/verify its user/);
    const forged = key.get("a");
    const last = forged.signature.length - 1;
    forged.signature.writeUInt8(forged.signature.readUInt8(last) ^ 1, last);
    expect(() => verifyAssertion({ ...forged, ...base, challenge: "a" })).toThrow(/does not verify/);
    expect(() => verifyAssertion({ ...key.get("a"), ...base, signCount: 99, challenge: "a" })).toThrow(/counter/);
  });

  test("a synced passkey that always reports 0 is accepted", () => {
    const key = new SoftKey("es256", false);
    const { publicKey } = verifyRegistration({ ...key.create("c"), challenge: "c" });
    expect(verifyAssertion({ ...key.get("a"), challenge: "a", origin: ORIGIN, publicKey, signCount: 0 })).toEqual({ signCount: 0 });
  });

  test("CBOR refuses what it does not need to read", () => {
    expect(() => decodeCbor(new Uint8Array([0x9f]))).toThrow(/indefinite/);
    expect(() => decodeCbor(new Uint8Array([0x5a, 0xff, 0xff, 0xff, 0xff]))).toThrow(/ends early/);
    expect(() => decodeCbor(new Uint8Array([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(/repeats/);
  });
});

describe("the root action", () => {
  let dir = "";
  let paths: SecurityKeysPaths;
  let now = Date.UTC(2026, 9, 22, 12);

  function account(name: string, id: number, status = 1, role = "ROLE_USER"): void {
    const db = new Database(paths.panelDb);
    db.run("CREATE TABLE IF NOT EXISTS user (id INTEGER, user_name TEXT, role TEXT, status INTEGER)");
    db.query("DELETE FROM user WHERE user_name = ?").run(name);
    db.query("INSERT INTO user VALUES (?, ?, ?, ?)").run(id, name, role, status);
    db.close();
  }

  async function run(argv: string[], input?: unknown): Promise<{ ok: boolean; data?: any; error?: string }> {
    let out = "";
    const write = process.stdout.write;
    const writeErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await runSecurityKeysAction(argv, { paths, input: input === undefined ? "{}" : JSON.stringify(input), now: () => now });
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
    }
    return JSON.parse(out);
  }

  async function register(user: string, key: SoftKey, name = "YubiKey", flags = UP | UV | AT) {
    const options = await run(["register-options", `--panel-user=${user}`]);
    if (!options.ok) return options;
    key.handle.value = options.data.user.id;
    const made = key.create(options.data.challenge, { flags });
    return run(["register", `--panel-user=${user}`], {
      challengeId: options.data.challengeId, name, origin: ORIGIN,
      clientDataJSON: b64(made.clientDataJSON), attestationObject: b64(made.attestationObject),
    });
  }

  async function signIn(key: SoftKey, overrides: Record<string, unknown> = {}) {
    const options = await run(["login-options"]);
    const proof = key.get(options.data.challenge);
    return run(["sign-in"], {
      challengeId: options.data.challengeId, id: b64(key.id), userHandle: key.handle.value,
      clientDataJSON: b64(proof.clientDataJSON), authenticatorData: b64(proof.authenticatorData), signature: b64(proof.signature),
      ...overrides,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/security-keys-`);
    mkdirSync(join(dir, "var"));
    paths = {
      stateDir: join(dir, "state"), lockFile: join(dir, "lock", "security-keys.lock"), panelDb: join(dir, "db.sq3"),
      panelVarDir: join(dir, "var"), stateUid: process.getuid?.() ?? 0,
    };
    account("alice", 7);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a registered key signs in by writing CloudPanel's own one-time token", async () => {
    const key = new SoftKey();
    const registered = await register("alice", key);
    expect(registered.ok).toBe(true);
    expect(registered.data.keys.map((k: { name: string }) => k.name)).toEqual(["YubiKey"]);

    const result = await signIn(key);
    expect(result).toMatchObject({ ok: true, data: { user: "alice" } });
    const file = join(paths.panelVarDir, `.token_${result.data.token}`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ userName: "alice", expiration: Math.floor(now / 1000) + 60 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(storePathOf(paths)).mode & 0o777).toBe(0o600);

    const listed = await run(["keys", "--panel-user=alice"]);
    expect(listed.data.keys[0].lastUsedAt).toBe(new Date(now).toISOString());
  });

  test("a challenge answers once, and not after it expires", async () => {
    const key = new SoftKey();
    await register("alice", key);
    const options = await run(["login-options"]);
    const proof = key.get(options.data.challenge);
    const body = {
      challengeId: options.data.challengeId, id: b64(key.id), userHandle: key.handle.value,
      clientDataJSON: b64(proof.clientDataJSON), authenticatorData: b64(proof.authenticatorData), signature: b64(proof.signature),
    };
    expect((await run(["sign-in"], body)).ok).toBe(true);
    expect(await run(["sign-in"], body)).toMatchObject({ ok: false, error: expect.stringMatching(/expired/) });

    const late = await run(["login-options"]);
    now += 6 * 60_000;
    const lateProof = key.get(late.data.challenge);
    expect(await run(["sign-in"], {
      ...body, challengeId: late.data.challengeId,
      clientDataJSON: b64(lateProof.clientDataJSON), authenticatorData: b64(lateProof.authenticatorData), signature: b64(lateProof.signature),
    })).toMatchObject({ ok: false, error: expect.stringMatching(/expired/) });
  });

  test("asking for a sign-in writes nothing, and a challenge id cannot be stretched", async () => {
    for (let i = 0; i < 25; i++) expect((await run(["login-options"])).ok).toBe(true);
    expect(readdirSync(paths.stateDir)).toEqual(["secret"]);

    const key = new SoftKey();
    await register("alice", key);
    const options = await run(["login-options"]);
    const [expiry, nonce] = options.data.challengeId.split(".");
    const proof = key.get(options.data.challenge);
    expect(await run(["sign-in"], {
      challengeId: `${Number(expiry) + 3_600_000}.${nonce}`, id: b64(key.id), userHandle: key.handle.value,
      clientDataJSON: b64(proof.clientDataJSON), authenticatorData: b64(proof.authenticatorData), signature: b64(proof.signature),
    })).toMatchObject({ ok: false, error: expect.stringMatching(/challenge does not match/) });
  });

  test("a registration started before the account was recreated does not finish", async () => {
    const options = await run(["register-options", "--panel-user=alice"]);
    account("alice", 8);
    const made = new SoftKey().create(options.data.challenge);
    expect(await run(["register", "--panel-user=alice"], {
      challengeId: options.data.challengeId, origin: ORIGIN,
      clientDataJSON: b64(made.clientDataJSON), attestationObject: b64(made.attestationObject),
    })).toMatchObject({ ok: false, error: expect.stringMatching(/challenge does not match/) });
  });

  test("a pipe or link planted at a token's name is skipped, not read", async () => {
    const key = new SoftKey();
    await register("alice", key);
    const fifo = join(paths.panelVarDir, `.token_${"c".repeat(64)}`);
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const outside = join(dir, "outside.json");
    writeFileSync(outside, JSON.stringify({ expiration: 0 }));
    const link = join(paths.panelVarDir, `.token_${"d".repeat(64)}`);
    symlinkSync(outside, link);
    expect((await signIn(key)).ok).toBe(true);
    expect(existsSync(fifo)).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  test("a key stops working for a deactivated account and for a recreated one of the same name", async () => {
    const key = new SoftKey();
    await register("alice", key);
    account("alice", 7, 0);
    // Who exists and who is deactivated is not the login page's to say.
    expect(await signIn(key)).toMatchObject({ ok: false, error: expect.stringMatching(/unavailable right now/) });
    account("alice", 8);
    expect(await signIn(key)).toMatchObject({ ok: false, error: expect.stringMatching(/no longer exists/) });
    expect((await run(["keys", "--panel-user=alice"])).data.keys).toEqual([]);
    expect(readdirSync(paths.panelVarDir)).toEqual([]);
  });

  test("an unknown key, a borrowed user handle and a reused key are refused", async () => {
    const key = new SoftKey();
    await register("alice", key);
    expect(await signIn(new SoftKey())).toMatchObject({ ok: false, error: expect.stringMatching(/not registered/) });
    expect(await signIn(key, { userHandle: "someone-else" })).toMatchObject({ ok: false, error: expect.stringMatching(/not registered/) });
    account("bob", 9);
    expect(await register("bob", key)).toMatchObject({ ok: false, error: expect.stringMatching(/already registered/) });
  });

  test("a registration is the account's that started it", async () => {
    account("bob", 9);
    const key = new SoftKey();
    const options = await run(["register-options", "--panel-user=alice"]);
    const made = key.create(options.data.challenge);
    expect(await run(["register", "--panel-user=bob"], {
      challengeId: options.data.challengeId, origin: ORIGIN,
      clientDataJSON: b64(made.clientDataJSON), attestationObject: b64(made.attestationObject),
    })).toMatchObject({ ok: false, error: expect.stringMatching(/challenge does not match/) });
  });

  test("a user removes their own key; an administrator removes anyone's", async () => {
    account("bob", 9);
    const one = new SoftKey();
    const two = new SoftKey("ed25519");
    await register("alice", one, "Laptop");
    await register("bob", two, "Phone");
    expect((await run(["users"])).data.users.map((u: { user: string }) => u.user)).toEqual(["alice", "bob"]);
    expect(await run(["remove", "--panel-user=bob"], { id: b64(one.id) })).toMatchObject({ ok: false });
    expect((await run(["remove", "--panel-user=alice"], { id: b64(one.id) })).data.keys).toEqual([]);
    expect((await run(["revoke"], { user: "bob", id: b64(two.id) })).data.users).toEqual([]);
    expect(await signIn(two)).toMatchObject({ ok: false });
  });

  test("every role may use keys until an administrator turns one off", async () => {
    account("root-admin", 1, 1, "ROLE_ADMIN");
    const key = new SoftKey();
    // Registering answers with the same view of the account as listing does.
    expect(await register("alice", key)).toMatchObject({ ok: true, data: { keys: [{ name: "YubiKey" }], canAdd: true, syncedPasskeys: true } });
    expect(await run(["keys", "--panel-user=alice"])).toMatchObject({ data: { canAdd: true, syncedPasskeys: true } });
    expect((await run(["users"])).data.settings).toEqual({ roles: ["ROLE_ADMIN", "ROLE_SITE_MANAGER", "ROLE_USER"], syncedPasskeys: true });

    const saved = await run(["settings"], { roles: ["ROLE_ADMIN"], syncedPasskeys: true });
    expect(saved.data.settings.roles).toEqual(["ROLE_ADMIN"]);
    expect(await run(["keys", "--panel-user=alice"])).toMatchObject({ data: { canAdd: false } });
    expect(await signIn(key)).toMatchObject({ ok: false, error: expect.stringMatching(/turned off for your account/) });
    expect(await register("alice", new SoftKey())).toMatchObject({ ok: false, error: expect.stringMatching(/turned off/) });
    expect((await register("root-admin", new SoftKey())).ok).toBe(true);
    // Kept, and still the user's to remove.
    expect((await run(["keys", "--panel-user=alice"])).data.keys).toHaveLength(1);

    await run(["settings"], { roles: ["ROLE_USER", "ROLE_ADMIN"], syncedPasskeys: true });
    expect((await signIn(key)).ok).toBe(true);
    expect((await run(["users"])).data.settings.roles).toEqual(["ROLE_ADMIN", "ROLE_USER"]);
  });

  test("with synced passkeys off, only device-bound keys are added or accepted", async () => {
    const synced = new SoftKey("es256", false);
    expect((await register("alice", synced, "Bitwarden", UP | UV | AT | BE)).ok).toBe(true);
    await run(["settings"], { roles: ["ROLE_ADMIN", "ROLE_SITE_MANAGER", "ROLE_USER"], syncedPasskeys: false });
    expect(await signIn(synced)).toMatchObject({ ok: false, error: expect.stringMatching(/synced passkeys/) });
    expect(await register("alice", new SoftKey(), "Phone", UP | UV | AT | BE))
      .toMatchObject({ ok: false, error: expect.stringMatching(/hardware keys/) });
    const hardware = new SoftKey();
    expect((await register("alice", hardware)).ok).toBe(true);
    expect((await signIn(hardware)).ok).toBe(true);
  });

  test("settings are only CloudPanel's roles and a boolean", async () => {
    expect(await run(["settings"], { roles: ["ROLE_ROOT"], syncedPasskeys: true })).toMatchObject({ ok: false });
    expect(await run(["settings"], { roles: [], syncedPasskeys: "yes" })).toMatchObject({ ok: false });
    expect(await run(["settings", "--panel-user=alice"], { roles: [], syncedPasskeys: true })).toMatchObject({ ok: false });
    expect((await run(["settings"], { roles: [], syncedPasskeys: true })).data.settings.roles).toEqual([]);
  });

  test("own-account verbs need --panel-user and nothing else takes it", async () => {
    expect(await run(["keys"])).toMatchObject({ ok: false, error: expect.stringMatching(/--panel-user/) });
    expect(await run(["login-options", "--panel-user=alice"])).toMatchObject({ ok: false });
    expect(await run(["users", "--panel-user=alice"])).toMatchObject({ ok: false });
  });

  test("an expired token of the same shape is cleared on the next sign-in, a live one is left", async () => {
    const key = new SoftKey();
    await register("alice", key);
    const stale = `.token_${"a".repeat(64)}`;
    const live = `.token_${"b".repeat(64)}`;
    writeFileSync(join(paths.panelVarDir, stale), JSON.stringify({ userName: "x", expiration: Math.floor(now / 1000) - 1 }));
    writeFileSync(join(paths.panelVarDir, live), JSON.stringify({ userName: "x", expiration: Math.floor(now / 1000) + 600 }));
    await signIn(key);
    expect(existsSync(join(paths.panelVarDir, stale))).toBe(false);
    expect(existsSync(join(paths.panelVarDir, live))).toBe(true);
  });
});

function storePathOf(paths: SecurityKeysPaths): string {
  return join(paths.stateDir, "credentials.json");
}

test("the injected blocks are opaque to Twig", () => {
  for (const target of SECURITY_KEYS_TARGETS) {
    const snippet = target.snippet("/addons/security-keys");
    const inner = snippet.slice(snippet.indexOf("{% verbatim %}") + 14, snippet.lastIndexOf("{% endverbatim %}"));
    expect(snippet.trim().startsWith("{% verbatim %}")).toBe(true);
    expect(inner).not.toContain("endverbatim");
    expect(inner).not.toContain("ADDON_URL");
  }
});

test("the admin list groups keys by user and marks what needs review", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const key = (id: string, name: string, synced: boolean, lastUsedAt: string | null) =>
    ({ id, name, synced, lastUsedAt, origin: "https://panel.example.com:8443", createdAt: "2026-01-02T00:00:00Z" });
  const users = [
    { user: "admin", active: true, role: "ROLE_ADMIN", keys: [key("a", "YubiKey", false, "2026-10-23T08:00:00Z"), key("b", "Bitwarden", true, null)] },
    { user: "gone", active: false, role: null, keys: [key("c", "Old key", false, "2026-03-01T00:00:00Z")] },
    { user: "nobody", active: true, role: "ROLE_USER", keys: [] },
    { user: "jane", active: true, role: "ROLE_SITE_MANAGER", keys: [key("d", "Laptop", false, "2026-10-20T00:00:00Z")] },
  ];
  const page = dashboardView({ users, settings: { roles: ["ROLE_ADMIN"], syncedPasskeys: false } }, now);
  expect(page.match(/class="sk-group"/g)).toHaveLength(3);
  expect(page).toContain("<strong>admin</strong> <span class=\"hint\">Administrator · 2 keys</span></th>");
  expect(page).toContain("<strong>gone</strong> <span class=\"hint\">1 key</span> <span class=\"sk-refused\">No longer signs in</span>");
  expect(page).toContain("<strong>jane</strong> <span class=\"hint\">Site manager · 1 key</span> <span class=\"sk-refused\">Role is off</span>");
  expect(page).not.toContain("nobody");
  expect(page).toContain("4 keys for 3 users");
  expect(page).toContain("Synced passkey, not accepted");
  expect(page).toContain("1 synced passkey is on file and refused while this is off.");
  // A tile per role, counting what it holds or refuses; a deactivated account counts for none.
  expect(page).toMatch(/id="role-ROLE_ADMIN" type="checkbox" checked /);
  expect(page).toContain('<strong>Administrators</strong><span class="hint">2 keys</span>');
  expect(page).toContain('<strong>Site managers</strong><span class="sk-refused">1 key refused</span>');
  expect(page).toContain('<strong>Users</strong><span class="hint">No keys</span>');
  // The refused passkey, the deactivated account and the role that is off.
  expect(page.match(/data-blocked/g)).toHaveLength(3);
  expect(page).not.toContain("Device-bound");
  expect(page).toContain(">Yesterday</time>");
  expect(page.match(/sk-key is-stale/g)).toHaveLength(2);
  expect(page).not.toContain("<span class=\"badge");
  const empty = dashboardView({ users: [], settings: { roles: [], syncedPasskeys: true } }, now);
  expect(empty).toContain("Set up security keys");
  expect(empty).not.toContain("sk-table");
  expect(empty).toContain("Every role is off, so nobody can add a key or sign in with one.");
});

test("Today and Yesterday follow the UTC calendar, not 24-hour spans", () => {
  const used = (lastUsedAt: string, at: string) => dashboardView({
    users: [{ user: "admin", active: true, role: "ROLE_ADMIN", keys: [{ id: "a", name: "YubiKey", synced: false, lastUsedAt, origin: "https://panel.example.com:8443", createdAt: "2026-01-02T00:00:00Z" }] }],
    settings: { roles: ["ROLE_ADMIN"], syncedPasskeys: true },
  }, Date.parse(at)).match(/UTC">([^<]+)<\/time>/)?.[1];
  expect(used("2026-10-23T23:00:00Z", "2026-10-24T01:00:00Z")).toBe("Yesterday");
  expect(used("2026-10-24T00:30:00Z", "2026-10-24T23:30:00Z")).toBe("Today");
  expect(used("2026-10-21T23:59:00Z", "2026-10-24T00:01:00Z")).toBe("3 days ago");
});
