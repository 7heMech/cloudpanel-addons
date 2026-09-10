# CloudPanel Addons: Core Modernization & Simplification Specification

> **STATUS: SUPERSEDED (HISTORICAL IMPLEMENTATION BRIEF).** This document is
> not a live task brief. The migration it specifies has already landed, and in
> at least one important place (Task 3, authentication) landed **differently
> than specified here**. It is kept, unedited in substance, as the record of
> what was planned and why. Do not treat it as a description of the current
> system, and do not resume work against it as if it were open.
>
> For current architecture, read
> [`DECISIONS.md`](DECISIONS.md#current-architecture), specifically "Current
> architecture" at the top of that file, and "Authentication is CloudPanel's,
> not ours (superseded)" for the full history of why Task 3 below was not what
> shipped. Corrections are marked inline below where a specific claim needs
> one; everything else in this file describes the plan, not the result.

> **Target Audience:** Implementing Subagents / Developers
> **Objective:** Transition `cloudpanel-addons` from an external standalone reverse-proxy site into an integrated CloudPanel subpath (`/addons/`) served over a UNIX domain socket, with CloudPanel session-based Single Sign-On (SSO), unified single-path updates, and a streamlined CLI.

---

## 0. Branching & Agent Isolation Rules

> **No longer applicable.** These were speculative onboarding instructions for
> two agents to attempt this specification concurrently on separate branches.
> The work this file specifies is done, landed on `main` through the normal
> history of this repository, and no `refactor/sso-unix-socket-variant-*`
> branch exists or should be created. Kept only so the plan for concurrent
> execution is on record.

To allow two independent agents (or approaches) to execute this specification concurrently without Git collisions:

* **Agent 1:** Must work strictly in branch `refactor/sso-unix-socket-variant-a`
* **Agent 2:** Must work strictly in branch `refactor/sso-unix-socket-variant-b`
* **Rules:**
  1. Do **not** commit to or push directly to `main`.
  2. Create your branch off the current `HEAD` of `main`:
     ```bash
     git checkout -b <your-branch-name>
     ```
  3. Ensure all tests (`bun test`, `tsc --noEmit`, `shellcheck`) pass in your branch before declaring completion.

---

## 1. Architectural Overview & Design Decisions

### Current State vs. Target State

| Dimension | Current Architecture | Target Modernized Architecture |
| :--- | :--- | :--- |
| **Routing / Hostname** | Separate CloudPanel site (e.g. `addons.example.com`) | Integrated subpath on CloudPanel's master origin (`https://<cp-host>/addons/`) |
| **Site Management** | Creates reverse-proxy site in CloudPanel SQLite (`db.sq3`) | **No CloudPanel site created** (zero footprint in `site` table) |
| **Identity & Account** | Hacked site user (`addon-xxx`) with disabled SFTP shell | Clean system user (`clp-addons`) with no login |
| **IPC Transport** | TCP loopback `127.0.0.1:38080` (open to all local tenants) | UNIX domain socket (`/run/clp-addons/manager.sock`, `0660`) |
| **Authentication** | Custom scrypt credentials in `/etc/clp-addons/manager-auth` | SSO via CloudPanel `PHPSESSID` $\rightarrow$ internal HMAC cookie *(planned; **not** what shipped. No HMAC cookie exchange exists. What shipped is a direct, unprivileged, bounded parse of the `PHPSESSID` session on every request, with no token issuance and no caching cookie. See `DECISIONS.md` "Authentication is CloudPanel's, not ours (superseded)".)* |
| **Binary Paths** | Multiple dirs (`/usr/local/bin/clp-addons` & `/releases/<tag>`) | Single active binary (`/usr/local/bin/clp-addons`) |
| **Updates** | Disjointed `update`, `upgrade`, and `self-update` commands | Unified single-step `clp-addons update` |
| **Status CLI** | 30+ lines of raw internal diagnostics | Clean, scannable terminal dashboard |

---

## 2. CloudPanel Environment Inspection (Docker / Deb)

Before writing session verification logic, agents should inspect CloudPanel's source and configuration.

### A. Quick Extraction (Offline, ~15s)
Unpack the official CloudPanel `.deb` package to inspect Symfony session settings, security configs, and Twig templates:
```bash
mkdir -p /tmp/clp-inspect && cd /tmp/clp-inspect
curl -fsSL https://d17k9fuiwb52nc.cloudfront.net/dists/bookworm/main/binary-amd64/Packages.gz | zcat > Packages
DEB_PATH=$(awk -v RS= '/Package: cloudpanel\n/' Packages | grep '^Filename:' | awk '{print $2}')
curl -fsSL -O "https://d17k9fuiwb52nc.cloudfront.net/${DEB_PATH}"
dpkg-deb -x cloudpanel*.deb ./rootfs

# Key inspection targets:
# 1. Security firewall: ./rootfs/home/clp/htdocs/app/files/config/packages/security.yaml
# 2. Twig templates:   ./rootfs/home/clp/htdocs/app/files/templates/
# 3. Master Nginx cfg: ./rootfs/etc/nginx/sites-enabled/ (or templates)
```

### B. Live Testing in Docker (Optional)
```dockerfile
# Dockerfile.test
FROM debian:bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt update && apt install -y systemd systemd-sysv curl gnupg sudo lsof debsums redis-server postfix
RUN curl -fsSL https://d17k9fuiwb52nc.cloudfront.net/key.gpg | gpg --dearmor -o /etc/apt/trusted.gpg.d/cloudpanel-keyring.gpg && \
    echo "deb https://d17k9fuiwb52nc.cloudfront.net/ bookworm main nginx php-8.2" > /etc/apt/sources.list.d/cloudpanel.list && \
    apt update && apt install -y cloudpanel
CMD ["/lib/systemd/systemd"]
```

---

## 3. Implementation Tasks

### Task 1: Dedicated System Account & UNIX Socket
1. **User Setup:**
   * During install/provisioning, ensure system user `clp-addons` exists:
     ```bash
     id -u clp-addons >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin clp-addons
     usermod -aG clp clp-addons # Add to clp group so it shares socket access with Nginx
     ```
2. **Systemd Service (`/etc/systemd/system/clp-addons.service`):**
   * Service runs as `User=clp-addons`, `Group=clp-addons`.
   * Configure `RuntimeDirectory=clp-addons` (creates `/run/clp-addons/` at boot with `0755` permissions).
   * Update `ExecStart=/usr/local/bin/clp-addons serve`.
3. **Bun Server Binding:**
   * *(Correction: this landed in `cli/index.ts`, not
     `addons/instatic/app/service.ts`: that file has no `Bun.serve`/socket
     code at all. The actual bind is `cmdServe()` at `cli/index.ts:469-502`,
     and it is shared by every installed addon, not per-addon; see
     `DECISIONS.md` "One compiled binary, not one per addon".)*
   * In the manager's server initialization, bind to UNIX socket:
     ```typescript
     const SOCKET_PATH = "/run/clp-addons/manager.sock";
     Bun.serve({
       unix: SOCKET_PATH,
       fetch: handleRequest,
     });
     // Ensure permissions allow Nginx (group clp) to connect:
     chmodSync(SOCKET_PATH, 0o660);
     ```

### Task 2: CloudPanel Nginx VHost Injected Proxy
1. **Target Config:** CloudPanel's master panel vhost (typically `/etc/nginx/sites-enabled/cloudpanel.conf` or the default SSL server block on port 8443 / domain).
2. **Injected Block:**
   ```nginx
   # clp-addons:proxy:start
   location /addons/ {
       proxy_pass http://unix:/run/clp-addons/manager.sock:/;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_buffering off;
       proxy_read_timeout 3600s;
   }
   # clp-addons:proxy:end
   ```
3. **Reconciliation & Safety:**
   * Extend `cli/inject.ts` to manage this block.
   * **Mandatory Invariant:** Run `nginx -t` before reloading Nginx. If `nginx -t` fails, revert immediately to the pristine snapshot to ensure CloudPanel never goes down.

### Task 3: Root Session Validation & Token Exchange (NOT WHAT SHIPPED)

> **This task's design was superseded before implementation and was never
> built as specified.** Nothing named `clp-verify-session` exists anywhere in
> this repository; there is no `/run/clp-addons/hmac.key`; no request ever
> receives `Set-Cookie: clp_addons_token=...`. `tools/test-app.test.ts` and
> `tools/test-provision.test.ts` assert all three of those absences directly,
> as a regression guard against this design creeping back in.
>
> **What is still correct below, and carried forward into what shipped:**
> a session cannot be trusted blindly. It has to be checked for expiry and
> for an authenticated security token, and `mfaAuthenticated`/2FA has to be
> checked explicitly, not assumed. Both of those requirements are enforced by
> what actually shipped.
>
> **What shipped instead:** `lib/sso-auth.ts` parses the `PHPSESSID` session
> file directly, **unprivileged**, in the same process that serves the
> request: no `sudo`, no separate root helper binary, no HMAC token issuance
> or caching cookie. It validates the session id against `^[a-zA-Z0-9,-]+$`,
> `lstat`s the session file and rejects symlinks, requires the file be owned
> by the panel user `clp`, and caps its size, before running a bounded custom
> PHP-serialization scanner (explicit depth and node limits) that checks
> `_sf2_meta` expiry, the `_security_main` token, and `mfaAuthenticated ===
> true`. An invalid or missing session redirects to `/login` on every request.
> There is no cached "already verified" fast path to invalidate on logout,
> because there is nothing cached. See `DECISIONS.md`, "Current architecture
> -> CloudPanel SSO" for the mechanism with file and line citations, and
> "Authentication is CloudPanel's, not ours (superseded)" for why an
> *unprivileged* parser answers the objection that ruled out a root-privileged
> one.
>
> The original task text is preserved below for the record of what was
> planned:

1. **Root Session Validator Script (`/usr/local/libexec/clp-addons/clp-verify-session`):**
   * Invoked via `sudo` by `clp-addons` user.
   * Argument validation: Accepts `--cookie=<id>`. Validates strictly against `^[a-zA-Z0-9,-]+$` (rejects path traversals).
   * Reads `/var/lib/php/sessions/sess_<id>`.
   * Verifies session:
     - File exists and is non-empty.
     - Within session lifetime (`_sf2_meta` timestamps).
     - Contains an authenticated security token (ensures 2FA is completed if enabled).
   * Emits single JSON contract: `{"valid":true,"user":"admin"}` or `{"valid":false}`.
2. **Manager Auth Middleware:**
   * Incoming requests to `/addons/*` check for `Cookie: clp_addons_token=...`.
   * If valid (verified using an HMAC secret saved at `/run/clp-addons/hmac.key`), pass request immediately (<0.05ms, zero `sudo`).
   * If missing/invalid, check `Cookie: PHPSESSID=...`.
     - Invoke `clp-verify-session` once.
     - If valid: issue `Set-Cookie: clp_addons_token=<hmac_token>; Path=/addons; HttpOnly; SameSite=Lax` and proceed.
     - If invalid: respond with `302 Redirect` to `/login`.

### Task 4: Removal of Dead Code (~800 Lines)
1. **Delete `lib/manager-auth.ts`:** Remove scrypt password hashing, local credential storage, and password reset CLI commands.
2. **Purge from `cli/provision.ts`:**
   - `ensureManagerSite()` and calls to `clpctl site:add:reverse-proxy`.
   - `siteUserFor()`, `siteUserOf()`, `hardenSiteUser()`, `assertNotInDockerGroup()`.
   - `siteBasicAuth()`, `panelBasicAuthCredential()`, `writeManagerAuth()`.
   - `SITE_CREATED_MARKER` tracking for manager site.
3. **Purge Symlink Release Tree:**
   - Remove `/usr/local/lib/clp-addons/releases/<tag>` version directories and `current` symlinks.
   - Remove `placeRelease()`, `pruneReleases()`, `releaseArtifacts()`, and `addonIsAtRelease()`.
4. **Streamline `install.sh`:**
   - Remove `--domain` flag requirement, DNS checks, Let's Encrypt certificate prompting, and login credential banner.

### Task 5: Single Binary Path & Unified `clp-addons update`
1. **Filesystem Layout:**
   - Primary Binary: `/usr/local/bin/clp-addons` (Used by both CLI and systemd service).
   - Addon actions: compiled into `/usr/local/bin/clp-addons` under `action`.
   - Sudoers Drop-in: `/etc/sudoers.d/clp-addons` allowing `clp-addons ALL=(root) NOPASSWD: /usr/local/bin/clp-addons action *`.
2. **Unified `clp-addons update`:**
   - Step 1: Query GitHub releases API for latest release.
   - Step 2: If up to date, report and exit.
   - Step 3: Fetch `clp-addons-linux-x64`. Verify checksums and Sigstore attestations.
   - Step 4: Atomically replace `/usr/local/bin/clp-addons`.
   - Step 5: `systemctl restart clp-addons`.
   - Step 6: Run `reconcile` on Twig templates and Nginx vhost.
   - Step 7: Deprecate `self-update`; make `upgrade` an alias to `update`.

### Task 6: Modern Terminal UI/UX
1. **Scannable `clp-addons status`:**
   Replace the raw log dump with structured ANSI status blocks:
   ```text
    CloudPanel Addons  v1.0.0
   ────────────────────────────────────────────────────────────────
    Status
      • Daemon      ● Active (PID 2140)
      • Transport   UNIX Socket (/run/clp-addons/manager.sock)
      • Nginx       VHost Injected & Verified ✓
      • Anchors     Twig Templates Patched ✓

    Installed Addons
      NAME       ROUTE              ACTION        STATE
      instatic   /addons/instatic   Verified ✓    ● Ready
      stager     /addons/stager     Verified ✓    ● Ready

    Dashboard URL: https://<cloudpanel-host>/addons/
   ────────────────────────────────────────────────────────────────
   ```
2. **Streamlined `install.sh` Output:**
   Run cleanly without interactive domain prompts:
   ```text
   › CloudPanel Addons Installer
   › Checking dependencies (Root, Docker, CloudPanel)... ✓
   › Downloading & verifying clp-addons-linux-x64... ✓
   › Setting up clp-addons system user and UNIX socket... ✓
   › Injecting CloudPanel navigation and Nginx proxy... ✓
   › Starting clp-addons.service... ✓

   ✓ Successfully installed!
     Access addons inside CloudPanel at: https://<cloudpanel-host>/addons/
   ```

---

## 4. Code Quality & Maintenance Directives

1. **Keep Cyclomatic Complexity Low:**
   - Use early return / guard clauses to avoid deeply nested conditionals.
   - Avoid deep inheritance or complex abstractions; keep operations linear and deterministic.
2. **Comment Pruning:**
   - Strip redundant comments that merely narrate what the next line of code does (e.g. `// check if user is null`, `// return true`).
   - Retain essential security invariants and architectural warnings (e.g. why `0660` socket permissions are mandatory, why `nginx -t` must run before reload).

---

## 5. Definition of Done (DoD)

- [ ] All code changes committed strictly to the designated feature branch.
- [ ] No CloudPanel site is created for the manager; `clp-addons` runs under a dedicated system user.
- [ ] Manager listens exclusively on `/run/clp-addons/manager.sock` (`0660`).
- [ ] Navigating to `/addons/` with an active CloudPanel session allows instant access with zero secondary login.
- [ ] Navigating to `/addons/` unauthenticated redirects cleanly to `/login`.
- [ ] `clp-addons update` atomically updates `/usr/local/bin/clp-addons` and restarts the service.
- [ ] All unit/integration tests (`bun test`) pass.
- [ ] Codebase line count is reduced, obvious comments are pruned, and no regressions are introduced to `instatic` or `stager`.
