# Decisions

Why the code is shaped the way it is. The current integrated-manager decisions
are recorded first; the historical notes below are retained for their rationale
and regression history. Where old deployment details conflict with the current
section, the current section wins.

## Current architecture

### Privilege boundary

The manager runs as the locked `clp-addons` system user and holds **no sudo
privileges at all**. Every privileged operation -- session validation, addon
actions, and the manager's own enable/disable/update verbs -- is a request on
the root gateway daemon's socket, `/run/clp-addons/auth.sock`. The daemon owns
the allow-list (`STAGER_ALLOWED_VERBS`, `INSTATIC_ALLOWED_VERBS`,
`MANAGER_ALLOWED_VERBS` in `lib/gateway-protocol.ts`) and spawns
`clp-addons action <addon> <verb>` itself, so the boundary is a verb the daemon
recognises rather than a command line a sudoers pattern has to match safely.

This replaced a sudoers drop-in that granted
`clp-addons ALL=(root) NOPASSWD: /usr/local/bin/clp-addons action *`. The
drop-in is gone, and `reconcilePanelIdentity` deletes any copy an older install
left behind on every install, update and repair. Nothing in `cli/`, `lib/` or
`addons/` writes one -- `tools/test-provision.test.ts` asserts that, because the
function that removes them was called `installSudoers` for long enough that its
name outlived the mechanism and misled a reader of its own log line.

The daemon also rejects unknown addons and verbs, and each action still requires
an installed addon configuration. See "The root auth helper is reached by socket
activation, not sudo" below.

Every action validates its complete argument set before reading input,
deriving paths, or taking a lock. Commands use argument arrays; no shell
evaluation or caller-supplied paths cross the boundary. Action stdout is one
JSON object and diagnostics go to stderr.

### Integrated manager and Nginx transport

The manager does not create a CloudPanel site or write the `site` table. One
process serves all installed addons under `/addons/` on CloudPanel's master
origin. `cli/inject.ts` adds a marked Nginx location that proxies to
`/run/clp-addons/manager.sock`.

The injector snapshots the upstream vhost, reconciles its managed block, and
always runs `nginx -t` before a reload. A failed validation or reload restores
the pristine vhost immediately. Twig navigation uses the same
reconcile-from-pristine model, so multiple addon markers can coexist and
removing one cannot remove another's link.

### Identity and socket permissions

`clp-addons` has `/usr/sbin/nologin` and is a member of CloudPanel's `clp`
group. `clp-addons.service` runs as `User=clp-addons`, `Group=clp-addons`, with
`SupplementaryGroups=clp` and `RuntimeDirectory=clp-addons`. Its single active
entrypoint is:

```text
/usr/local/bin/clp-addons serve
```

The service creates `/run/clp-addons/manager.sock` with mode `0660`, owned by
`clp-addons:clp`, so Nginx can connect without exposing a TCP listener. The
root gateway additionally checks Linux `SO_PEERCRED` and `/proc/<pid>/exe` in
production socket-activation mode: the peer must be the `clp-addons` account
running the root-owned `/usr/local/bin/clp-addons` binary. It still dispatches
only the allow-listed verbs and fixed binary path. This is an executable
identity check rather than a permanent hash pin; the root-owned artifact
manifest and restart-on-update preserve the replacement boundary.

### CloudPanel SSO

Each protected request sends only the bounded `cloudpanel` session ID over the
root gateway's `/run/clp-addons/auth.sock` Unix socket to the root-only
`clp-addons action auth` helper. The helper uses only CloudPanel's fixed
session directory `/home/clp/htdocs/app/files/var/sessions`; the session id
must match `^[a-zA-Z0-9,-]{1,128}$`, followed by exactly one newline. The
helper `lstat`s the file before reading, rejects symlinks, requires ownership
by the panel user `clp`, caps its size, and emits only a validated principal
or an invalid marker. A bounded custom PHP-serialization scanner then checks
`_sf2_meta` expiry, the native five-slot `PostAuthenticationToken` state,
active user status, the canonical typed role list, and CloudPanel's MFA
marker/native-user agreement. `ROLE_ADMIN` is required at the shared manager
boundary before update lookup, index rendering, or mounted addon dispatch.
Invalid sessions redirect to `/login`; valid non-administrator sessions
receive `403`.

The token's role and status snapshot can remain stale if a user is demoted or
disabled in the panel database while the Addons path bypasses a subsequent
CloudPanel PHP request. The helper currently does not claim immediate
revocation; a fixed readonly account revalidation can be added only after the
installed User entity/schema contract is confirmed, without returning
credentials or hashes to the daemon.

This is a third design, and neither of the two that were written down first
shipped. That history, and why this one is judged safe despite it, is kept in
full under "Authentication is CloudPanel's, not ours" below. In short: the
original objection to self-parsing was to a **root-privileged** parser for an
undocumented, obfuscated-upstream format. `lib/sso-auth.ts` is unprivileged
(it runs as the `clp-addons` account, the same as every other request
handler), and the strict `lstat`/ownership/size/depth/node bounds are what turn
"parse an undocumented format" from that feared root-privileged wildcard into a
narrowly scoped, unprivileged, testable operation. `tools/test-app.test.ts` asserts this
design's absence of the alternative that was speculatively planned instead: no
HMAC token issuance/verification, and no `libexec/clp-verify-session` helper.

### Active artifact layout and updates

There is one active binary at `/usr/local/bin/clp-addons`; the compiled addon
actions live inside it. The private release-verification helper, when needed,
is the only separate file under `/usr/local/libexec/clp-addons/`; the active
installation has no release directory or `current` symlink. `clp-addons update`
resolves a release, verifies checksums and provenance when artifacts are needed,
atomically replaces the CLI and installed helpers, restarts the service, and
reconciles panel integration. A same-version update reuses artifacts only when
the root-owned manifest and every installed file's SHA-256 match; otherwise it
fetches and verifies them before reconciliation. `upgrade` is an alias;
`self-update` is a deprecation error.

### CloudPanel data and maintenance

Root reconciliation reads non-secret site and port fields into the sanitized
`/var/lib/clp-addons/snapshot.json`. Applications read that snapshot and use
their root action namespace for privileged operations. Instance actions may create and
manage the CloudPanel sites that represent addon instances; the manager itself
never creates one.

The periodic timer and template path unit invoke the same idempotent repair
commands used by installation. Repair restores service-user, socket, panel identity,
unit, snapshot, Twig, and Nginx invariants without a second login or manual
domain configuration.

## Historical design record

The sections that follow are preserved from the pre-socket design. They are
useful rationale and regression history, but statements about a manager site,
per-site Basic Auth, a TCP listener, release-tree storage, or custom manager
credentials describe the superseded implementation. The current decisions
above take precedence.

Two more things changed partway through this historical record and are easy to
misread if you don't know which era a given entry is from: the two bash
wrappers described throughout the sections below were later deleted (see the
next entry), and the authentication design changed twice more after the
per-site Basic Auth section further down was written (see "Authentication is
CloudPanel's, not ours (superseded)"). Where an entry below has not been
marked superseded or historical, it is still describing current behavior.
Most of what follows is regression history for bugs that are still relevant,
not architecture that has moved on.

## The two bash wrappers were replaced by in-binary actions

`addons/instatic/wrapper/clp-action-instatic` (1039 lines of bash) and
`addons/stager/wrapper/clp-action-stager` (2827 lines of bash) are gone. Every
verb they implemented is now a TypeScript action compiled into the single
`clp-addons` binary, reached as `clp-addons action <addon> <verb>`. The
sudoers rule at the top of this document names exactly that namespace.
`addons/instatic/action.ts` and `addons/stager/action.ts` are what the root
side now runs.

**The privilege boundary did not move.** This is worth being exact about,
because "the wrapper is gone" reads like it could mean the app now runs
privileged code in-process, and it does not. The manager still crosses from
the unprivileged `clp-addons` account to root the same way it always did: by
`sudo`-spawning a *subprocess*. See "Privilege boundary" and "The root action
is the whole security model" below; both are otherwise unchanged by this
migration. What changed is the identity of the thing sudo spawns: it is
now the same compiled `clp-addons` binary, invoked with an `action` argument
prefix, rather than a separate standalone bash script. Argument validation,
the "stdout is exactly one JSON object" contract, and the stdin-only secret
channel (both credentials and MFA codes, per "Both of the source's credentials
are on stdin, never in argv" above) are now implemented once, in TypeScript,
instead of being maintained twice: once in each bash script, at nearly 4,000
lines combined, with all the drift risk that implies for two files enforcing
one security model.

**`install.sh` stays bash, deliberately and permanently.** It is the one place
in this project where "port it to TypeScript" is not the answer. It is fetched
and executed as `curl -fsSL .../install.sh | bash` (`README.md:60`), and at
that point in the bootstrap nothing capable of interpreting TypeScript exists
on the target machine yet. The whole job of `install.sh` is to get the
`clp-addons` binary (which embeds the Bun runtime) onto the box in the first
place. A shell script is the only thing that can be the very first artifact
fetched.

## The root action is the whole security model

The `action` namespace runs as root via one sudoers line. Everything it permits,
the unprivileged app account can do as root. The account's isolation is worth
exactly as much as the action validation is strict, so those modules are the
ones to review line by line.

Rules, none negotiable:

- **Validate before acting.** Parse every argument, validate it, *then* derive
  paths and take locks. Deriving the lock path from an unvalidated `--domain`
  once let `../../../tmp/x` place a root-owned file outside the lock directory.
- **Reject; never sanitize.** A sanitizer that silently rewrites hostile input
  hides the attempt and eventually rewrites it wrong.
- **argv arrays only.** No `sh -c`, no `eval`, no backticks, no interpolating
  into a command string.
- **No free-form arguments.** No paths, no filenames, no registry host, no
  compose file location. One such argument and the verb list stops being closed.
- **The registry is hardcoded.** Only the tag crosses the boundary.
- **One wrapper per addon**, so a bug in one cannot be walked through to reach
  another's verbs. `ALL=(root)`, one absolute path, no wildcards:
  `NOPASSWD: /usr/bin/clpctl *` is equivalent to full root. *(One absolute
  path with no wildcard on the path is still the rule the shipped sudoers line
  follows. See "Privilege boundary" above. "One wrapper per addon" itself is
  now carried by validation inside the one binary rather than by separate
  binaries: the sudoers rule matches every addon's `action` verbs, and the
  binary rejects an unknown or uninstalled addon name itself. The property
  this bullet protects, that a bug in one addon's verbs cannot reach
  another's, now rests on that in-binary check rather than on the OS-level
  separation a second sudoers line used to give for free, which is a real
  trade worth knowing about rather than assuming away.)*
- **stdout is a contract**: exactly one JSON object. Progress goes to stderr.
  Never scrape prose for meaning.

### `set -e` in the wrapper, specifically (historical only, no longer applicable)

This subsection describes a bash failure mode, and no longer describes a live
invariant of the code: the two bash wrappers it was written about were deleted
in favor of TypeScript actions compiled into `clp-addons` (see "The two bash
wrappers were replaced by in-binary actions" below), and TypeScript has no
`set -e`/`pipefail` control-flow surface for this class of bug to hide in. It
is kept because the shape of the bug (a function whose only failure path is
silent) is a real lesson, and because `tools/integration-action-instatic.ts` still exists
and still encodes exactly this rationale in its own header comment, even
though it now drives `clp-addons action instatic` rather than a bash script:
it still asserts that every verb *emits something* on valid input, which is
what would catch this class of bug if TypeScript ever grew an equivalent
foot-gun, and a rejection-only test suite still would not.

Two silent failures have come from the same shape:

```bash
foo() {
  [[ cond ]] && emit_err "..."     # returns 1 when cond is FALSE
}
foo "$x"                            # set -e: exits, with no output at all
```

A trailing `&&` list returns non-zero on the *success* path. The function then
returns non-zero, and `set -e` aborts the script producing nothing -- which is
indistinguishable from a no-op. Use `if`, and end validators with `return 0`.

The same applies to `pipefail`: `x=$(cmd | tr ...)` aborts the assignment when
`cmd` exits non-zero, even though the pipeline produced the value you wanted.
Add `|| true` where a non-zero exit is expected.

`tools/integration-action-instatic.ts` asserts that every verb with valid input *emits
something*, which is what catches this class. A rejection-only test suite does
not -- the bug lives on the success path.

## Placement: the addon is its own CloudPanel site (superseded)

**Superseded.** The manager no longer binds `127.0.0.1` or is reached through
a CloudPanel site at all. It is reached over a UNIX socket via a path on the
panel's own vhost, which is exactly the variant this entry describes as tried
and removed. See "Current architecture -> Integrated manager and Nginx
transport" and "-> Identity and socket permissions" for what replaced it and
why the objections below no longer apply the same way (the socket transport
does not go through `proxy_pass` blind to the PHP session the way the rejected
`location /instatic/` variant did; see "Current architecture -> CloudPanel
SSO" for how the session is actually checked today). Kept for the reasoning
that led to the original per-site design, and because the specific
`location /instatic/` variant it rejected is close to what was eventually
built successfully once session validation was solved differently.

The manager binds `127.0.0.1` and is reached through a stock CloudPanel
reverse-proxy site, with per-site security in front. Not a path on the panel's
own vhost.

The panel-vhost variant is tempting because it is same-origin, and it was tried:
a `location /instatic/` block proxying to the app. It was removed because

- `proxy_pass` bypasses CloudPanel's PHP session check entirely, so the page was
  reachable with no credentials at all while every real panel path redirected to
  `/login`;
- the panel regenerates its own vhost and `cloudpanel.postinst` replaces
  `/home/clp/htdocs/app` wholesale on upgrade, so the block is a second fragile
  surface the reconciliation timer would have to watch;
- same-origin buys nothing anyway, because there is no way to share the panel's
  PHP session. Authentication has to be added either way.

An own site gets SSL, backups and the panel's own security UI for free.

## The manager runs as CloudPanel's site user (superseded)

**Superseded.** The manager does not run as a CloudPanel site user any more.
There is no manager site to have a user. It runs as the dedicated `clp-addons`
system account, created by `ensureServiceUser()` (`cli/provision.ts:164-188`)
with `useradd --system --no-create-home --shell /usr/sbin/nologin`, then
locked with `passwd -l`. See "Current architecture -> Identity and socket
permissions" for the account as it exists today. The reasoning below, that a
login shell and SFTP password on the one account permitted to escalate is a
liability CloudPanel would otherwise hand out by default, is exactly why the
dedicated system account is created `nologin` and locked from the start rather
than hardened after the fact; it is preserved as the history of *why* that
matters, not as a description of the current account.

Decision 2.4 says the addon runs as the site user CloudPanel creates. An earlier
version created a dedicated `instatic-app` account instead, which meant two
accounts existed for one addon site and uninstall had its own user to clean up.
The site user is now resolved from the panel database after the site is created,
and the legacy account is removed on install and repair.

CloudPanel gives site users a login shell and a password so operators can reach
the docroot over SFTP. For this site that is a liability rather than a feature:
it is a pure reverse proxy with an empty docroot, and it is the one account
permitted to `sudo` the root wrapper. Left as-is, the site's SFTP credentials --
visible to anyone with panel access to that site -- would be a path to root.

So the installer sets the shell to `nologin` and locks the password, and
`repair` re-asserts both, because editing the site in the panel can restore the
shell. `clp-addons status` reports the state.

This is the one place the design deliberately hardens something CloudPanel set
up, rather than leaving panel-managed state alone. It is worth the exception
because the alternative is a documented escalation path.

## Instances run as their own site user too

The first pass at decision 2.4 changed only the manager. Instances kept the uid
baked into the Instatic image, and the wrapper chowned their data to `1000:1000`
to match it. On a CloudPanel box uid 1000 is `clp`, the account that owns the
panel and `db.sq3`, so every instance's data belonged to the panel's own
identity and all instances shared one.

Each instance already has a CloudPanel site, and therefore a site user. That
account is now the instance's identity: `docker run --user <uid>:<gid>`, with
`data` and `uploads` owned by it. The uid is read from the `site` table rather
than derived from the domain, because a site the addon adopted keeps whatever
user it already had. `instatic.env` stays root-owned: it holds the master key,
and the site user has SFTP.

Ownership is re-applied on every container start rather than only at create.
The failure it prevents is quiet -- a container that cannot write its database
still answers `GET /`, so the health check passes and the instance looks fine
until someone tries to save something. `tools/integration-action-instatic.ts` asserts the
running container's uid matches the panel's record and that it can actually
write, because neither is visible from the outside.

Docker fixes a container's configuration at creation, so restarting an instance
built by an older release will not move it. The `recreate` verb rebuilds it
from the recorded tag, leaving the data in place.

## The bootstrap installer is a release asset

The documented one-liner used to read `install.sh` off
`raw.githubusercontent.com` at a hardcoded tag. Two problems, and the second was
live: the tag had to be edited into the README by hand after every release, and
because nobody did, the published command was still serving the v0.1.0
installer -- which predates the tokenless provenance fix and therefore demanded
`gh auth login` from anyone who ran it.

`install.sh` is now built into `dist/` alongside the binaries, so it appears in
`SHA256SUMS`, is covered by the same build provenance attestation, and is
reachable through GitHub's `/releases/latest/download/` redirect. The README
points at that redirect and stops going stale.

The original rule was "point at a tag, never at `main`", on the grounds that
piping a moving target into a root shell means the script you audited is not the
script that runs. The redirect is still a moving target, so that reasoning is
narrowed rather than abandoned: it moves only when a release is cut, the thing
it moves to is immutable within that release, and it is attested -- none of
which is true of a branch. An operator who wants to audit first can fetch a
pinned release asset and verify it before running it, which the README shows.

## Provenance is verified from a released bundle, not from the API

Verification has to work without a GitHub account: `gh attestation verify` on
its own reaches for the attestations API and demands `gh auth login` or a token
even for a public repository, which would put an account in the path of every
install. Passing `--bundle` avoids that, but something has to produce the
bundle first.

Fetching it from the attestations API works and needs no credentials, but the
API returns bundles wrapped in an envelope, so the caller has to parse JSON to
unwrap them. In the bootstrap installer that meant a Python heredoc -- a
dependency the preflight check did not even test for, added by a comment
explaining that `jq` could not be relied on. Trading `jq` for `python3` is not
an improvement, and needing either to install a shell script is the wrong shape
of problem.

The release now publishes `attestations.jsonl`, every artifact's bundle, one
per line. `gh` reads that file directly, and a single file verifies any one of
the artifacts, so the installer parses nothing and the CLI makes one download
instead of an API call per artifact.

Serving the bundles from the release rather than the API is not a weaker
position. A bundle is signed and bound to its subject's digest, so an attacker
who can replace a release asset cannot produce one that verifies against the
replacement -- the failure mode is a refused install, not a silent accept.

## One CloudPanel site for every addon, routed by path (superseded twice over)

**Superseded a second time.** This entry's own conclusion -- "one site, one
`clp-addons.service`, one account" -- was itself superseded: the manager now
creates **zero** CloudPanel sites and is served at `/addons/` off the panel's
own vhost over a UNIX socket (see "Current architecture -> Integrated manager
and Nginx transport"). The "routing is in the manager, not in nginx" argument
below is still exactly why: nothing in `clpctl` grew a way to add per-path
upstreams to an existing vhost, so the manager still does its own internal
routing (`splitMount`/`MANAGERS`, `cli/index.ts:495-497`). There is just no
site left to mount it under any more. The two bulleted "consequences in the
app" below, describing `lib/mount.ts`, are still exactly true today; only the
"one site" framing around them is history.

Each addon used to get a site of its own. That is a hostname, a certificate, a
Basic Auth setup and a site user per addon, and the addon is unreachable until
the first two are done and unsafe until the third is. Four manual steps per
addon, repeated.

What it bought was worth stating honestly: one account per addon meant a
compromised manager could sudo its own wrapper and not the other's, so an
attacker got one closed verb set rather than the union. That is a real property.
It is not worth what it costs, because a control whose reliable output is "I will
do the auth later" protects less than its diagram suggests -- and the README
already had to shout that a manager is unsafe until the operator has done the
work.

So: one site, one `clp-addons.service`, one account, and the addons mounted under
it by path. The one account can sudo every installed addon's wrapper. That is
said out loud in the unit file rather than left to be discovered, and it puts all
the weight on the wrapper's argument validation -- which is where it always
actually was.

**The routing is in the manager, not in nginx, and that is forced.** Measured
against the panel rather than assumed:

  - the stock reverse-proxy vhost has exactly one `{{reverse_proxy_url}}`, inside
    a single `location @reverse_proxy`
  - `clpctl site:add:reverse-proxy` rejects `--vhostTemplate` outright -- "The
    "--vhostTemplate" option does not exist"
  - the `site` namespace is `add:*`, `delete` and `install:certificate`. Nothing
    rewrites an existing site's vhost.

So per-path upstreams in nginx would mean writing `site.vhost_template` directly,
and every addon installed afterwards would mean writing it again -- against an
undocumented schema, while the panel is running, racing the panel's own writes.
One process on one port needs none of it, and the vhost stays stock, which is
what keeps `clpctl` the only thing that writes panel state (decision 2.6).

Two consequences in the app:

  - `lib/mount.ts` owns the mapping from addon name to path, and both sides
    import it: the CLI builds the panel's nav URLs from it, and each addon's
    views build their own links from it. An addon reaching into `cli/paths.ts` to
    find out where it is served would be the app depending on the installer.
  - `call()` in the shared client script prefixes every fetch with the mount, so
    an addon's routes are still written as though it owned the site. The two
    places that bypass `call()` -- a raw `fetch` and a `location.href` -- have to
    prefix by hand, which is exactly the kind of thing a test should hold, and
    `splitMount` is tested for the prefix-is-not-a-segment case that would send
    `/instatic-notes` to instatic.

## One compiled binary, not one per addon

`bun build --compile` embeds the Bun runtime, so every artifact carried a
complete copy of it. Measured on the v0.5.2 build:

```
empty bun --compile binary   81,315,296 bytes
clp-addons-linux-x64         81,372,640   ->  56 KB of code
instatic-app-linux-x64       81,343,968   ->  28 KB
stager-app-linux-x64         81,339,872   ->  24 KB
```

244 MB of release assets to deliver 108 KB of code, three copies of the same
runtime, and another 77.6 MB for each addon added. The runtime is not the part
that varies.

So there is one artifact. `clp-addons` is the CLI, and `clp-addons serve`
is the one manager for every installed addon, not one manager per addon. The
systemd unit ExecStarts that rather than a binary of its own. 81.4 MB total,
and an addon now costs an entry in one dispatch table, not a wrapper script.

**This went further than the original one-binary decision anticipated, and is
worth recording precisely (reversed from "`clp-addons serve <addon>`").**
`cmdServe()` (`cli/index.ts:469`) takes no addon argument at all. It binds one
shared UNIX socket (`Bun.serve({ unix: SOCKET_PATH, ... })`,
`cli/index.ts:477-502`) and dispatches every request to the right addon
internally via `splitMount(path, mounted)` against the `MANAGERS[hit.addon]`
table (`cli/index.ts:495-497`). There is one `clp-addons.service`
(`cli/provision.ts:400`), running as the one dedicated `clp-addons` system
account (`User=clp-addons`), not any CloudPanel site account, because no
addon site exists any more (see "Current architecture -> Identity and socket
permissions").

Two consequences worth stating, because both were load-bearing in how it was
done:

- **The addon modules export a starter, and do not serve on import.** A
  module-level `Bun.serve` would run for `clp-addons status` as much as for
  `serve`. The CLI imports every manager statically -- at this size there is
  nothing to gain from a dynamic import -- so those modules must have no import
  side effect.
- **`serve` takes no default addon.** `resolveAddon(undefined)` answers instatic,
  which is a fair default for a command an operator types and a bad one inside a
  unit file: a typo in `ExecStart` would start the wrong manager on the wrong
  port and look like it worked.

`serve` is also the one verb that is deliberately not `requireRoot`. That
part is unchanged and still visible in the code: it is absent from the
`requireRoot` call sites (`cli/index.ts:199,245,287,401`, covering `install`,
`update`, `repair` and `uninstall`). The reason has moved on with the rest of
this entry: `serve` now runs as the one `clp-addons` system account, not a
CloudPanel site user, and its single privileged path is sudo-invoking its own
`action` namespace (see "Privilege boundary" above), not "its own wrapper".

## `update` moves the CLI first, then hands over to it

`update` fetches what the *running* CLI believes a release contains. That is
fine until a release changes the artifact set, and then it is a hard stop: v0.6.0
merged the per-addon app binaries into one, so a v0.5.2 CLI asked v0.6.0 for
`instatic-app-linux-x64` and refused to go on. The documented answer was
`self-update` first, which worked because `self-update` only ever fetches the CLI
-- an asset every release has.

Telling an operator to run two commands in the right order is a worse answer than
running them in the right order. So `update` brings the CLI to the target release
before it touches an addon.

Doing that in one process would not have been enough, and this is the part worth
remembering: writing `${CLI_BIN}` does not change the process already executing.
The old code would still have driven the addon updates, with the old idea of the
artifact set, and the failure would have been identical. So `update` installs the
new CLI and then **re-runs the same command as that copy**, with `spawnSync` and
inherited streams so the hand-over is invisible in the output.

The re-run carries `--no-self-update`, which is what bounds it. A version that
never compares equal -- a local build reports `0.0.0-dev` and no release ever
matches it -- would otherwise re-run forever instead of failing once.

`upgrade` is an alias. Both are what people type, and answering one of them with
"unknown command" is a worse outcome than doing the job.

## An artifact already in the release tree is not downloaded again

The artifact set is per release, not per addon: `current` is shared, so every
call has to fetch every installed addon's copy. That made the cost quadratic in
addons. `update` with two installed fetched all five artifacts twice, about 480
MB where 240 would do, and `install.sh` did the same by invoking the CLI once
per addon.

`releases/<tag>` is where `placeRelease` has already written whatever an earlier
call fetched, so it doubles as the cache. No second directory, no cleanup path
of its own: `pruneReleases` already owns it.

Reuse is gated on the release's own recorded checksum, so it is not a weaker
check than downloading. A file sitting in the right directory under the right
name whose bytes hash to something else is downloaded again rather than trusted
for being in the right place, and the provenance attestation afterwards runs
over the same bytes either way. The sigstore bundle is still fetched every time,
because it is a few kilobytes and is what detects substitution.

The bootstrap installer seeds that directory with the CLI it has just verified,
before handing off. Otherwise the CLI was downloaded twice on every fresh
install: once by `install.sh`, which then deletes its temp directory, and once
by the CLI itself, whose cache looks in a release tree nothing had created yet.
On a single-addon install that was a third of the whole download. Seeding cannot
smuggle anything in, because the CLI re-hashes whatever it finds against the
release's own SHA256SUMS before using it, and what the installer places there
has already been checked against the same file.

The tag is shape-checked in `install.sh` before it is used, because at that
point it stops being only a URL fragment and becomes a path component that root
writes to.

The directory is a parameter with a default so the reuse logic can be tested
somewhere writable, for the same reason the injector's paths are parameters.

## The platform owns the panel templates; addons only supply markup

The injector used to live inside the Instatic addon, and `cli/index.ts`
imported it directly. That read as untidy layering. It was worse than untidy:
two addons could not coexist, and none of it was visible with one installed.

Pristine state was keyed by the addon's target rather than by the template. So
the second addon to install snapshotted a file that already contained the first
addon's block -- with that block stripped as if it were its own, because the
markers were a module-level constant naming Instatic. Reconstructed against the
real code, with two synthetic addons patching one template:

    both installed        : A=false B=true
    uninstall addon A     : A=false B=false
    B reconciles (15 min) : A=false B=true
    A reconciles (15 min) : A=true  B=false

Installing B silently deleted A's nav entry; the two reconciliation timers then
overwrote each other every fifteen minutes; and uninstalling either removed
both.

The pristine copy is now keyed by the template, because the template is what is
shared, and rendering re-applies every installed addon's snippet in one pass
from that copy. Removal is not a separate operation: uninstalling an addon
means reconciling without its injections, so there is no second code path that
could disagree with the first. Reconciling with none restores the file exactly
and deletes the snapshot.

Three supporting choices:

- The injector owns the markers, which name the addon and the target
  (`{# clp-addons:instatic:header-nav:start #}`). An addon supplying its own
  could pick another addon's by accident, which is precisely what happened.
- Addons declare a template path relative to CloudPanel's templates directory.
  An addon has no business knowing where the panel keeps its files, and a value
  import from the registry back into an addon would close an import cycle.
- Injections for one file are applied in a stable order, so two addons patching
  one anchor cannot swap places on each reconciliation and produce a file that
  never settles.

`bun run test:inject` runs the whole scenario against a throwaway template and
asserts what the old design got wrong: installing the second addon keeps the
first, uninstalling one leaves the other, repeated reconciliation is idempotent
and byte-stable, and removing the last addon restores the original exactly.

Markers written before v0.3.0 had no slug segment. The strip pattern still
matches them, because the first reconciliation after an upgrade would otherwise
snapshot a file with the old block still in it and bake that nav entry into the
pristine copy permanently. Snapshots from the old per-addon keying are deleted
on sight: they have no `.path` sidecar, nothing reads them, and an operator
would reasonably mistake them for current.

## The action module's files are the only record of what exists

The manager kept its own SQLite table of instances beside the action
module's `meta.json` files. Two records of one fact drift, and these did: an instance
created by calling the action module directly never appeared in the dashboard, and a
delete that failed part-way left a row describing something that was already
gone. The table was also the thing `nextPort` consulted, so a drifted row meant
a port handed out twice or never reused.

The files on disk and the running container are the state. The action module
has a `list` verb that walks its own data directory and reports each instance's
recorded metadata with live container state, and the manager holds nothing of
its own -- `app.db` and `db.ts` are gone, along with every write that kept them
in step.

It has to be one call rather than one per instance, because the manager cannot
read those directories: each belongs to its instance's own identity. `list` is
also the one verb exempt from the per-domain lock. It names no domain, so there
is nothing to lock, and locking would mean the dashboard stops rendering
whenever any instance is mid-update -- precisely when someone is looking at it.

Port allocation is a proposal rather than a reservation: the manager picks the
lowest free port and the action module re-checks it under the lock. That is the honest
description of what was always happening, and it no longer depends on a record
only the manager maintained.

The re-check had to be written before that sentence was true. `validate_port`
checked the range and nothing else, so a number two sides had both handed out
met as `docker run` failing to bind, reported as "failed to start container"
with nothing naming the port. That is reachable without anyone doing anything
odd: the Stager allocates from the same reserved block for the clone of an
Instatic site, both sides read a snapshot the root CLI rewrites every fifteen
minutes, and each was compensating only for its own creates inside that window.
`cmd_create` now refuses a taken port by name, from two sources -- another
instance's `meta.json`, which covers one that is stopped and therefore not
listening, and a listening socket, which covers everything else including a
clone the Stager has in flight, whose instance does not exist yet and so has no
record to find.

The manager side is narrowed but not symmetric, and it is worth being exact
about which half is which. The Stager counts live Instatic instances as well as
its own in-flight jobs, so it no longer proposes a port the Instatic addon has
already used. The Instatic dashboard still cannot see a Stager clone whose
instance does not exist and is not listening yet -- that window closes at
`cmd_create`, which refuses by name rather than failing at `docker run`. So the
residual case is a clear refusal, not a collision, and the two are not the same
guarantee. And neither list may fail quietly on that path. `listInstances()` and `listJobs()` return an empty array
when the action module cannot answer, which is right for a dashboard -- it renders
"none" and an operator reads it as such -- and wrong for an allocator, where it
means every port in use silently disappears from the calculation. The allocation
path calls strict variants that throw instead.

## One naming scheme for the accounts CloudPanel creates for us

`clpctl site:add:reverse-proxy` requires `--siteUser` and only generates a name
for sites created through the panel's own UI, so this addon has to supply one.
It used to supply two: `a<addon>-<domain>` for the manager's site and
`inst_<domain>` for an instance's, both truncated to fifteen characters.

Two schemes for one job is the smaller problem. The larger one is that
truncation made uniqueness rest on a prefix of the domain, and `site.user` is
UNIQUE, so `demo.clp-stg.local` and `demo.clp-stg.example.com` both reduced to
`inst_democlpstg` and the second site failed from inside clpctl with nothing
explaining why.

There is now one scheme, used for every site this addon creates:

    addon-<first 8 alphanumerics of the domain>-<6 hex of sha256(domain)>

Hashing the whole domain is what makes it safe; the readable fragment is for
operators reading `/etc/passwd`, and the `addon-` prefix both marks ownership
and guarantees the name starts with a letter, which a domain beginning with a
digit would not. CloudPanel accepts the resulting 21 characters -- verified
against a real `site:add:reverse-proxy` before adopting the length.

The manager's site and an instance's site are named the same way on purpose.
They are both just sites this addon created; which one is the manager's is
already recorded in `OWN_DOMAIN`, and encoding a role in the account name would
be a second source of truth for something the config already answers.

It used to be written twice -- once in `cli/provision.ts` and once in the
wrapper, which was bash and could not import TypeScript -- and `tools/test-app.ts`
ran both implementations over a list of domains and asserted they agreed,
including the pair that used to collide. **That dual-implementation risk no
longer exists (reversed).** The scheme (`domainStem`, `domainHash`,
`siteUserFor`) is implemented exactly once, in `cli/action-common.ts:220-230`,
and both `addons/instatic/action.ts:13` and `addons/stager/action.ts:12` import
`siteUserFor` from there; `cli/provision.ts` does not reimplement it or
reference it at all. A single shared TypeScript module imported by both addons
is a stronger guarantee than the cross-checking test the old two-implementation
design needed. There is nothing left that could drift. The two-schemes
history above is kept because it is still the reason a single source of truth
matters here: it is what happens when there isn't one.

Nothing migrates. The name is only ever used at creation; everywhere else the
account is read back from the panel's `site` table, so sites created under the
old schemes keep working under their old names.

## The dashboard's inline script is syntax-checked in CI

The client-side script is a TypeScript template literal interpolated into the
page, which means TypeScript consumes one level of backslash before a browser
ever sees it. A `\n` written for the browser arrives as a real newline, and
inside a single-quoted JavaScript string that is a SyntaxError.

The consequence is out of all proportion to the typo: the error takes down the
entire `<script>` element, so every handler on the page is undefined and every
button silently does nothing. Nothing else notices. The server renders, the
routes answer, the wrapper works, the tests pass -- the failure is visible only
in a browser console. It shipped, and the dashboard's buttons were dead through
four releases while the wrapper underneath them was being exercised directly.

`tools/test-app.ts` compiles the script with the `Function` constructor, which
parses without executing, and separately reports any line that leaves a quote
open so the failure names a line rather than an offset into a 4 KB blob. It
runs in CI. Escapes intended for the browser must be doubled, and this is what
enforces that.

## Uninstall reverses install, and says what it will destroy

`uninstall` removes the manager and un-patches the panel but leaves instances
alone, so it cannot become an accidental way to delete a customer's site.
`--purge` is the full reversal, and it delegates each instance to the wrapper's
own `delete` verb rather than reimplementing the teardown: that path already
archives the data, passes `--force` so `clpctl` cannot block on a prompt, and
refuses to delete a site the addon did not create.

Ordering matters and was wrong at first: instances are removed through the
wrapper, so the wrapper has to outlive that loop and is deleted afterwards, not
before. The release tree and `clp-addons` itself are shared between addons, so
they go only when no other addon's config remains -- deleting the binary that
is currently executing is safe, since the inode survives until the process
exits.

Both forms print an inventory naming every instance and site they will touch,
and refuse to act without `--yes`. "and every instance" is not something an
operator can check against what they believe is on the box; a list of domains
is. Whether the manager's own site is removed depends on a marker written at
install time -- if the addon adopted an existing site, that site was serving
something first and is left in place.

## The app has no Docker access

Membership in the `docker` group is equivalent to root: a member can start a
container with `/` bind-mounted. The app was briefly in that group so it could
run `docker inspect` and `docker logs` directly, which made every restriction in
the wrapper decorative.

Container state and logs are wrapper verbs (`status`, `logs`) for this reason.
`clp-addons status` reports the group if it reappears; `repair` removes it.

## Systemd sandboxing is real, with explicit carve-outs (reversed)

An earlier revision of this entry said sandboxing was "deliberately thin" and
that the usual hardening directives were absent entirely. That is no longer
true, and reading it as current has already misled two reviews.

The shipped unit (`serviceUnit()`, `cli/provision.ts:400-431`) sets, at
`cli/provision.ts:420-425`:

```
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=yes
ProtectKernelTunables=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/etc/nginx -/etc/letsencrypt /etc/php /home /run/clp-addons /run/lock/clp-addons /var/backups/clp-addons /var/lib/clp-addons
```

plus `UMask=0007` (`cli/provision.ts:429`).

One sub-claim of the original entry does stay true: `NoNewPrivileges` is still
off, and still on purpose. The service's only privileged path is sudo-spawning
the same binary's `action` namespace as root (see "Privilege boundary" above,
and the reversed migration entry below for what changed and what did not), and
`NoNewPrivileges=yes` blocks sudo outright -- that reasoning was never wrong and
still holds.

**What changed, kept as history.** The original entry argued that
`ProtectSystem`/`ProtectHome` could not be applied at all, because "namespace
directives are inherited by children" and "the wrapper legitimately needs
`/home/clp` to read the panel database and `/etc` because `clpctl` writes
vhosts" -- so, in that reasoning, sandboxing the unit "would break the boundary
rather than reinforce it." That was the read at the time and it was not
unreasonable: a blanket `ProtectHome=yes`/`ProtectSystem=strict` really would
have broken the sudo'd action's need to touch `/home` and `/etc`. What the
entry missed is the middle path: `ReadWritePaths=` scopes exactly those holes
back open (`/home`, `/etc/nginx`, `/etc/php`, and the addon's own state, lock,
backup and runtime directories), while `ProtectSystem=full`,
`ProtectHome=read-only`, `PrivateTmp=yes` and `ProtectKernelTunables=yes` still
apply everywhere else. The isolation that holds today is that scoped set of
directives plus the unprivileged account plus the one-line sudoers rule, not
an unsandboxed unit.

## Panel state is a sanitized snapshot

The port-collision check needs the panel's site list, but the panel database
holds password hashes and site credentials, and the app's account cannot read
`/home/clp` at all. So the privileged side reads non-secret columns and writes
`/var/lib/clp-addons/snapshot.json` (0640, temp-file-and-rename); the app reads
only that.

This is enforced by file layout: `lib/panel-snapshot.ts` is root-only and
`lib/snapshot-reader.ts` is what the app imports. "The app cannot read the panel
database" should be visible in the imports, not be a convention someone has to
remember.

## The panel-side anchor

CloudPanel's Twig templates are proprietary and are never committed here, in any
form. The pristine copy is snapshotted off the running box into
`/var/lib/clp-addons/templates`, patched from there, and hashed there.

- **Outside `/home/clp/htdocs/app`**, because `cloudpanel.postinst` moves that
  directory aside and extracts a fresh copy on upgrade. A pristine backup kept
  beside the template is destroyed by the exact event it exists to survive.
- **Regenerate from pristine**, never patch what is on disk. Patching a
  possibly-patched file eventually double-applies.
- **Hash the pristine copy.** The panel's PHP is obfuscated and cannot be
  diffed, but Twig is plain text. If upstream's copy stops matching the recorded
  hash, CloudPanel has touched the file our patch targets, so stop and flag.
  Applying a patch built for the old markup is worse than having no link.
- **The check is functional, not a file diff.** A marker block whose content no
  longer matches the expected snippet counts as stale, not present -- otherwise
  changing the addon's hostname leaves the nav pointing at the old one forever.
- **Purging the Twig cache is mandatory.** Twig serves the compiled copy until
  the cache is gone.

### Reconciliation: a timer plus a path unit

Reconciliation is a systemd timer, not a dpkg hook: a hook catches apt-driven
updates and misses manual ones, while a timer catches every path including
unattended-upgrades at 6am. `clp-addons-reconcile.timer` fires
`OnCalendar=*:0/15` (`cli/provision.ts:469`) and its service runs
`clp-addons repair --quiet` (`cli/provision.ts:463`), so there is one
implementation of "make the box match what should be installed": the service
user, sudoers, systemd units, the panel snapshot, the Twig anchors and the
Nginx proxy. **It now also runs the Stager's own maintenance verb, `prune`**
(`runStagerMaintenance`, `cli/index.ts:295-303`, called from `cmdRepair` after
the Nginx proxy reconciliation above), gated on the Stager addon being
installed and never allowed to fail the rest of `repair`. That wiring was
missing for a long time; see "Job records expire" and "Known gaps" below for
that history and for why the ordering (after, not before, the Nginx proxy
step) matters.

A 15-minute timer means up to 15 minutes with the nav entry missing, so a
`.path` unit watches the two templates and repairs on change. Measured on a
real `cloudpanel.postinst` run with the timer stopped: wiped at 09:36:45,
repaired at 09:36:50.

The watch is a **root-run systemd path unit, not a watcher inside the addon
service**. The obvious idea is that the Bun service is still running during a
panel update and could re-patch the files itself, but `/home/clp` is `0700
clp:clp` -- the service account cannot even traverse into it. Giving it the
access would mean either the `clp` group, which is read/write over the entire
panel tree, or a new wrapper verb. Both widen the privilege boundary to save a
few minutes, and systemd already does the job from outside it.

The path unit triggers `clp-addons-anchor.service`, which runs
`repair --anchors-only`, rather than the full reconciliation. Pointing it at the
full repair was measurably wrong: an update rewrites the templates repeatedly
while it extracts, and that produced six wrapper reinstalls, twelve `visudo`
runs and six `daemon-reload`s inside twenty seconds, in the middle of a package
upgrade. A two-second `ExecStartPre` coalesces the burst.

Both stay. The path unit is fast but can miss an event; the timer is the
backstop and also refreshes the snapshot and the sudoers drop-in.

## Instances

- **Reverse Proxy site type, never a new value in `site.type`.** The panel keys
  tab rendering, vhost regeneration and clpctl validation off that column.
- **Never edit vhosts or write to the panel database.** `clpctl` covers site
  creation; anything after that means writing an undocumented schema while the
  panel is running, where a wrong row shape corrupts panel state rather than
  failing cleanly. This costs a feature: an instance's port cannot be changed
  from the UI. Accepted.

  Read as "never write panel state ourselves", not "never reproduce a vhost".
  This bullet is about instances, and it was taken as a platform-wide ban, which
  cost the Stager addon a feature it could have had all along -- see "Carrying a
  site's vhost to its clone". The test is whether `clpctl` can be made to do the
  writing. When it can, doing it through `clpctl` is not an exception to this
  rule, it is the rule.
- **Pin an exact version, never `latest`.** With a floating tag you cannot tell
  what is running or roll back.
- **Bind to `127.0.0.1` explicitly.** Docker publishes past ufw, so `3001:3001`
  exposes the instance to the internet with the firewall shut.
- **Ports from 39000-39999**, well clear of where CloudPanel hands out Node.js
  and Python app ports. The manager itself sits outside that block (38080) so it
  can never collide with an instance.
- **`INSTATIC_SECRET_KEY` is generated once per instance and never rotated by an
  update.** The image runs `NODE_ENV=production`, where Instatic refuses to boot
  without it, and it encrypts recoverable secrets such as API keys and TOTP
  seeds -- a new key leaves every previously encrypted row unreadable. It is
  passed by `--env-file`, not `-e`, so it never appears in `ps` output, and it
  travels inside snapshots, because a restored database without it has
  unreadable secret columns.
- **Snapshot with `sqlite3 .backup`, not `cp` or `tar` over the live file**,
  which can capture a database mid-write. The `-wal`/`-shm` pair is skipped;
  `.backup` folds it in, and copying it alongside would restore a torn pair.
- **Update is snapshot, pull, restart, health check, auto rollback.** The health
  check polls the container, then confirms nginx actually serves the hostname.
  On failure the container logs are captured before rolling back. Auto-update is
  off by default: Instatic is 0.0.x and its APIs will shift before 1.0.

## The reconciliation timer needs a calendar trigger

The timer carried only monotonic triggers: `OnBootSec=2min` and
`OnUnitActiveSec=15min`. Both anchor to an event in the past, and once systemd
decides there is no future elapse the unit parks in `SubState=elapsed` and never
fires again. It still reports `active`.

Found on the staging box, thirteen and a half hours dead:

    NextElapseUSecMonotonic=infinity      SubState=elapsed
    LastTriggerUSec=Sun 2026-09-06 01:10:45 EEST

Two things made it worse than a missed tick. `systemctl restart` on the timer
does not revive it -- measured, it came back still `elapsed` with no next elapse,
and only activating the service itself re-anchored `OnUnitActiveSec`. And
`startUnits()` restarts this timer on every install and update, so cutting a
release was itself a chance to kill reconciliation. The recovery line in
`repair` was `systemctl start` on an already-active unit, which is a no-op, so
the self-healing path could never fix the one state that needed fixing.

What stops silently when it dies: the nav entry stays gone after a CloudPanel
update, the panel snapshot goes stale, and nothing re-asserts `nologin` on the
one account permitted to `sudo` the wrapper. The `.path` unit still covers the
template case, which is why the box looked fine.

`OnCalendar=*:0/15` always has a next elapse, so the unit cannot get stuck.
Verified against the failing operations: a scratch unit held its next elapse
through three restarts and a `daemon-reload` issued while the triggered service
was running. `Persistent=true` also starts meaning something, having only ever
applied to `OnCalendar=`.

`status` now prints the next elapse rather than `is-active` alone. "Active" was
the answer that hid this for thirteen hours, so it is not the question to ask.

## Snapshot archives are secrets at rest

`make_snapshot` copies `instatic.env` into the tarball on purpose -- decision
2.10 says the master key travels with the data, because a restored database
without it has unreadable secret columns. What was missing is that this makes
every archive as sensitive as the key file the wrapper keeps at 0600 root.

The mode was left to the caller's umask. Through the app's `sudo` that meant
0640, because the unit sets `UMask=0027`; run by root from a shell, which is the
`uninstall --purge` path, it meant 0644. `/var/backups/clp-addons/instatic` was
0755. So a deleted instance's entire database and the key that decrypts its API
keys and TOTP seeds sat world-readable, and on a CloudPanel box every site user
has SFTP. Confirmed on staging by reading one as an unrelated instance's uid.

The archive mode is now set here rather than inherited: `umask 077` around the
`tar`, an explicit `chmod 600`, and 0700 on both the backup directory and each
instance's `snapshots/`. Files written before this keep their old mode and
nothing else would ever revisit them, so `repair` tightens them, which is the
same reason `repair` re-asserts the login shell.

## `update --all` asked the wrong question

The loop skipped an addon when `currentRelease() === rel.tag`. That is a fact
about the shared release tree, not about the addon: the first addon called
`placeRelease()` and moved `current` onto the new tag, so every addon after it
matched, logged "already on", and had its app binary and wrapper skipped. The
run reported success for all of them.

`addonIsAtRelease()` asks about the addon's own files instead -- the release has
to carry its artifacts, and the wrapper actually installed has to be byte-equal
to the one in that release. Consistent with the rule that what is on disk is the
record.

## The dashboard says when a release happened

Auto-update is off by default because Instatic is 0.0.x, and that is only a
defensible policy if something tells the operator a release exists. Nothing did.
`listAvailableTags()` was wired into the New Site page alone, the dashboard
showed each instance's pinned tag with nothing to compare it against, and the
update dialog was a free-text box. Learning about 0.0.19 meant going to look at
ghcr.io and remembering the number.

The dashboard now fetches the same listing, badges instances behind the newest
version, counts them in a tile, and offers the real tags in a `<select>`.

Two things the listing has to get right. Versions are compared by number, not as
strings, or 0.0.9 outranks 0.0.18. And the registry paginates: it returns tags in
push order, so page one holds the *oldest* tags, and ignoring the `Link` header
would not produce an obviously broken dropdown -- it would keep offering a stale
version labelled "(latest)", which is worse. With 20 tags ghcr.io answers in one
response today, so this is a trap set for later rather than a bug now.

Only a listing that actually reached the registry may claim an instance is
behind. The offline fallback is one hardcoded version, and badging against it
would invent updates that do not exist. A stale cache still counts as a real
answer and says so; the fallback reports no newest version at all.

## The platform is multi-addon; most of it now actually is

"Multi-addon from the start" was the goal, and the injector was rebuilt for it
after two addons turned out to overwrite each other's nav entries. That fix was
real but narrow: the injector became addon-agnostic while the rest of the
platform kept the shape it had when Instatic was the only addon. A review found
five more places where the second addon would have been the one to discover it.

- `repair` reconciled whatever `resolveAddon()` defaulted to, which is instatic,
  and the timer runs `repair --quiet` naming no addon. A second addon would never
  have had its wrapper reinstalled, its sudoers line re-validated, its site user
  re-hardened or its service restarted. Anchors were the exception, because
  `reconcileAnchors()` already covered everything -- so the one visible symptom,
  a missing nav entry, was the one thing that still worked.
- `uninstall` deleted the reconcile timer, its service and the anchor path unit
  unconditionally, and all three are shared. Removing addon A stopped
  reconciliation for addon B, permanently: `repair` rewrites those units, and the
  timer that runs `repair` was what had just been deleted.
- The port scan in `panel-snapshot.ts` read one hardcoded directory. The `ss`
  scan beside it catches another addon's *running* instances, so the hardcoded
  path left exactly the case the directory scan exists for -- a stopped instance,
  whose port is still spoken for but not listening.
- `TEMPLATE_WATCH_PATHS` was a hand-written copy of Instatic's two templates. It
  is derived from the registry now, because nothing connected the two lists, so
  an addon patching a third template would have got no fast repair and no
  warning.
- `status` and `update` with no addon named defaulted to instatic rather than to
  everything installed.

`repair`, `status` and `update` now act on every addon with a config file on
disk, which is what "installed" means here.

## Authentication is CloudPanel's, not ours (superseded)

**This section is history, not current behavior.** It documents two designs in
sequence, neither of which is what shipped; the mechanism that actually ships
is described in "Current architecture -> CloudPanel SSO" above, with file and
line citations. Read what follows only for the rationale, not as a description
of the running system.

The manager can create and delete sites, so it must not be reachable without
authentication, and the question of where that comes from kept coming up.
Reusing the panel's admin login was checked properly rather than assumed. Two
of the three routes considered are still closed for the reason found here; the
third -- "validate the session ourselves" -- was the one this section rejected
and a later change reopened, deliberately and narrowly. That rejection is kept
verbatim because the design that shipped has to answer to it:

- **Share the session cookie.** `session.name = PHPSESSID`, scoped to the
  panel's origin, so we would have to be served from the panel's vhost. That is
  the injected-tab variant, and `proxy_pass` hands the request over without
  running any of the panel's PHP, so nothing validates the cookie. Same-origin
  gets you the cookie and none of the checking.
- **Validate the session ourselves.** Sessions are files under
  `/var/lib/php/sessions`, mode `1733 root:root` -- write and traverse for
  others, readable only by root, which is deliberate PHP hardening so one app
  cannot read another's sessions. The manager is unprivileged precisely so it is
  not root. Reading them anyway means a wrapper verb where root parses
  PHP-serialized Symfony security tokens, a format we cannot inspect because the
  panel's PHP is obfuscated and which upstream can change in any release. A
  root-privileged parser for an undocumented format, added to the one file that
  is the whole security model.
- **`api_token`.** The table exists. It authenticates calls *to* CloudPanel's
  API: "may this script act on the panel", not "is this browser a logged-in
  admin". Wrong direction, and reading it means reading the panel database.

The `user` table also carries `mfa` and `mfa_secret`, so anything reimplemented
here would have to honour MFA or become the weakest door to the same box. That
constraint is the one thing every design discussed in this section, including
the one that shipped, has had to satisfy.

**What was built on top of that rejection, and later replaced.** Given the
above, authentication became nginx Basic Auth, specifically **CloudPanel's own
per-site Basic Auth feature** (`site.basic_auth_id` / `clpctl
cloudpanel:enable:basic-auth`). Once a loopback TCP transport turned out to let
any local account reach the API directly (measured against a real box: every
hosted site's PHP account could `curl 127.0.0.1:38080/...` and get a 200), it
was joined by an application-level gate of its own: a `manager-auth`
credential, the panel's Basic Auth password re-hashed with scrypt, checked on
every request and failing closed with 503 when absent. **None of this exists
today.**
`lib/manager-auth.ts` does not exist; the only remnant is a cleanup constant,
`LEGACY_MANAGER_AUTH` (`cli/provision.ts:15`), used solely to delete the old
credential file during `repair`. The transport is a UNIX socket, not
`127.0.0.1:38080` (see "Current architecture -> Identity and socket
permissions"), which closes the "loopback has no permission model" problem at
the transport layer instead of papering over it with an application-level
credential.

**What was specified to replace it next, and also did not ship.**
An earlier draft proposal explored a privileged `clp-verify-session` helper invoked via `sudo`,
whose result would be cached behind an HMAC-signed `clp_addons_token` cookie so
most requests needed no `sudo` call at all. Nothing named `clp-verify-session`
was ever built, there is no `/run/clp-addons/hmac.key`, and no `Set-Cookie:
clp_addons_token=...` is ever issued. Its rationale is still correct and is
exactly what the shipped design also enforces: sessions cannot be trusted
blindly, and `mfaAuthenticated`/2FA must be checked; only the mechanism
proposed to enforce it was dropped in favor of something simpler.

**What shipped instead directly answers the "validate the session ourselves"
rejection above.** `lib/sso-auth.ts` parses the session unprivileged, in the
manager's own process, with no `sudo` and no HMAC exchange. The rejection above
was specifically of a *root-privileged* parser for an undocumented format; the
parser that shipped is not privileged, and the strict `lstat`, ownership, size,
depth and node bounds are what make an unprivileged parse of an undocumented
format a narrowly scoped, testable operation rather than the open-ended one the
rejection feared. See "Current architecture -> CloudPanel SSO" for the
mechanism and citations, and `tools/test-app.test.ts` / `tools/test-provision.test.ts`
for the tests asserting neither superseded design (scrypt manager-auth, or
root-helper-plus-HMAC) is present.

### The installer provisions gh rather than refusing without it

Provenance is the only check that detects a *substituted* binary -- the checksum
travels down the same channel as the artifact -- and the next thing the
installer does is run that artifact as root. So it cannot be optional by
default. But refusing outright puts a manual step in front of every new box,
and "is gh installed" turned out to be the wrong question twice over:

- Debian bookworm's own package is **gh 2.23**, and `gh attestation` arrived in
  **2.49**. On such a box the old check said yes and the verification then
  failed, reported as "provenance verification failed" -- which points the
  operator at the release rather than at their gh.
- On a box with no gh at all, the installer used to warn and continue, so the
  strongest check was the one almost nobody got.

Both are fixed by asking whether `gh attestation` exists rather than whether gh
does, and by fetching one when it does not. The tarball comes from
`github.com/cli/cli` over the same TLS the artifact already relies on, and its
published checksum is verified on the way in. This adds no trust assumption: it
is a *different* repository, so the attacker the attestation defends against --
one who can replace an asset in our release -- does not control it.

It lands at `/usr/local/lib/clp-addons/gh`, not on PATH and not via
`cli.github.com` in apt sources. Adding a third-party repository to a panel host
changes what every later `apt upgrade` pulls, which is a far larger and more
permanent footprint than one verification justifies. The CLI prefers that copy
for the same reason, so `clp-addons update` keeps verifying on a box whose
system gh is too old.

`--skip-attestation` still exists and now means what it says.

### Docker is asked about; gh is not

Both are dependencies fetched over the network, and they are treated
differently on purpose. `gh` is one static binary in a private directory: no
daemon, no apt source, no group, no network changes, and deleting it costs
nothing. Docker installs a daemon, adds a repository that changes what every
later `apt upgrade` pulls, creates a bridge interface, rewrites iptables rules,
and creates a `docker` group that is equivalent to root. On a CloudPanel host
the firewall rules are the part that matters, because the panel manages its own.
None of it is removed when the addons are.

So the rule is *side effects that outlive the addon need consent*, not
*dependencies are the operator's problem*. Docker is prompted for, defaulting to
no, over the same `/dev/tty` the installer already uses. `--install-docker`
exists for automation; `--yes` deliberately does not imply it, because that flag
means "do not ask me about addons and the hostname" and widening it into "add a
root-equivalent group and rewrite this host's firewall" is the scope creep it
should not have. A daemon that is merely stopped is started without asking --
that is not the same imposition as installing one.

The check also moved out of the unconditional preflight and behind the addon
selection, which is where it always belonged. `cli/index.ts` gates on the
`requiresUnits` of the addon being installed, so `clp-addons install stager`
never needed Docker; only the shell script demanded it of everyone, and the
Stager drives clpctl and tar and never opens a socket to a daemon. The two now
agree, and a test asserts the installer's list against the specs in paths.ts so
a future addon declaring `requiresUnits: ["docker"]` cannot silently fall out of
the prompt.

## The Stager addon

`clp-stager` is a Bash script you paste into `nano` on the server and run as
root. It works. Turning it into an addon is not about the steps, which are
unchanged in substance; it is about who is allowed to ask for them and what the
request may contain.

**The button is Twig, not HTML.** Instatic's injections are static markup: a nav
entry pointing at one hostname. The Stager button has to name the site whose
page it is rendered on, and `{{ site.domainName }}` is how the panel's own
templates already do that, so the snippet is a Twig fragment rather than a
string of HTML. The cost is that it is only correct where `site` is in scope,
which is a property of the target template rather than of the snippet -- both
targets either receive `site` as an include parameter or set it as a loop
variable, and a third one may not. It is also guarded by a membership test over
the site types the wrapper will clone, because a button that always errors is
worse than no button.

That guard is a mirror of `CLONABLE_TYPES` in the wrapper, which is the thing
that actually decides. One case it deliberately cannot mirror: a reverse-proxy
site is clonable only when its backend is an Instatic instance this box manages,
and that fact lives in the Instatic addon's own records, where Twig cannot reach
it. So the button appears on every reverse proxy and the wrapper refuses the ones
that are not, by name. Teaching the panel's templates about another addon's state
directory would be the worse trade.

**Cloning is a job, not a request.** A clone of a real site takes minutes:
`clpctl db:export`, a tar pipeline over the whole document root, `db:import`.
The manager's own vhost gives it 900 seconds and Bun caps a request well below
that, so a synchronous clone is not merely slow, it cannot finish. The wrapper
writes a job record, hands the work to `systemd-run`, and answers with an id the
page polls.

The transient unit is not a detail. The manager is a systemd service with
`Restart=always`, so anything it forks lives in that service's cgroup and is
killed with it -- and a fifteen-minute clone is long enough for a restart to be
ordinary rather than hypothetical, leaving a site half built. `systemd-run` asks
PID 1 for a cgroup of its own, which nothing this addon does can interrupt.
`Type=exec` rather than `oneshot`, because `oneshot` makes `systemd-run` wait
for the whole clone, which is the opposite of the point; `Type=exec` returns as
soon as the job has been exec'd, so a job that could not start at all is still
reported rather than sitting queued forever.

The lock is released before the job starts. Holding the target's lock across
`systemd-run` deadlocked the two against each other: the job blocked on `flock`
until its timeout, failed, and the failure surfaced as systemd refusing to start
it.

**The dump goes in the job directory, not `/tmp`.** The original writes
`/tmp/<production database>.sql.gz`, which is a full dump of a customer's
database in a world-readable directory under a name anyone can predict, and a
path any local user can pre-create as a symlink for root to write through. Job
directories are `0700 root` and the dump is deleted as soon as it is imported.

**Job records expire: the intent, and the gap this has today.** A record
holds the staging database password, which is the one credential in a clone
that the panel cannot show again and that the operator needs whenever the
application's config could not be rewritten. It is designed to be kept for
fourteen days (`JOB_RETENTION_DAYS`, `addons/stager/action.ts:17`), and
`prune` (`cmdPrune`, `addons/stager/action.ts:2186`) is what enforces that: it
deletes job directories past retention, recovers a job stuck recording
`"running"` after its unit has died, and recovers vhosts left carried by an
interrupted clone (`recoverCarriedVhosts`, `addons/stager/action.ts:1170`).

The plan on paper was that `repair` would run `prune` on every reconciliation,
because the timer that runs `repair` every fifteen minutes already exists and
giving the addon a timer of its own would be two answers to one question. **For
a long time that wiring was not built.** A `maintenanceVerb: "prune"` field
was declared on the Stager's `AddonSpec` for exactly this purpose, but nothing
ever read it. A tree-wide grep across the whole repository turned up only its
declaration and its one setting, so it has since been removed as dead code
(it was not what closed the gap; see below). For as long as that was true,
`cmdRepair` never called `prune`, and the only way to reach it was an
operator (or a script) explicitly running `clp-addons action stager prune` --
meaning none of the cleanup below ran automatically on any panel, ever, no
matter how long it had been up. See "Known gaps" for how bad that got in
practice (a killed clone permanently blocking re-clones of its target).

**Resolved.** `cmdRepair` (`cli/index.ts:305-344`) now calls
`runStagerMaintenance` (`cli/index.ts:295-303`), which runs `prune` through
the same `runStagerAction` path `action stager prune` always used, gated on
the Stager addon being installed. It runs after the Nginx proxy
reconciliation in the same function, not before: `recoverCarriedVhosts` does
its own `nginx -t` before reloading and skips the reload if that fails, so
running it after the master vhost is already known-good gives a
just-recovered site vhost its best chance of taking effect in the same
15-minute cycle instead of the next one. A `prune` failure is caught and
logged, never allowed to fail the rest of `repair`, since `repair` is the
self-healing path and nginx/sudoers reconciliation must run regardless.

**A custom root directory is not copied**, because `clpctl site:add:php` has no
option for one. The job says when the clone's differs from the source's.

**Names come from the one scheme.** The staging site's account is
`addon-<8>-<6 hex of sha256(domain)>`, the same as any other site this project
creates, and the database and its user are derived from the target domain the
same way rather than randomly. Deterministic names mean a retry after a failed
clone proposes the same names, so "already exists" means something.

## Carrying a site's vhost to its clone

A staging copy that does not reproduce its source's nginx config is not a
staging copy of the thing you are testing. On the box this was built against, 2
of 25 PHP sites have hand edits: one adds a Content-Security-Policy and strips
`X-Frame-Options` off the backend, the other widens `server_name` to a wildcard
and rewrites the WordPress multisite rules. Cloning either without its vhost
produces a site that behaves differently from production in exactly the way you
were trying to test.

The first attempt refused to do it, citing the "never edit vhosts or write to
the panel database" bullet under Instances. That bullet is about instances, and
applying it as a platform-wide law cost a feature that `clpctl` could deliver
without breaking it at all.

**`clpctl vhost-template:add` is the route.** The source's stored vhost becomes
a named template, the clone is created from it, and the template is deleted
again. The panel renders it, expands every placeholder against the clone's own
values, writes its own database record and the file on disk, and reloads nginx.
Nothing here writes panel state or touches a vhost.

Three facts make it work, and none of them were obvious:

- **`site.vhost_template` is not a rendered config.** It keeps
  `{{ssl_certificate}}`, `{{root}}`, `{{php_fpm_port}}` and the rest; only the
  hostnames are concrete. So the copy needs one substitution rather than a
  general rewrite, and the clone's certificate, document root, php-fpm port and
  log paths go on tracking its own settings. The original script copies the
  *rendered file* into that column instead, which freezes the source's values:
  the staging site keeps working, but a later certificate renewal or PHP version
  change regenerates from a column that can no longer follow it.
- **CloudPanel's own validator is half the safety.** `vhost-template:add`
  requires `{{server_name}}`. When the source's `server_name` line *is* the hand
  edit, folding it back into the placeholder would drop the edit and keeping it
  literal leaves no placeholder, so the panel refuses the template and the clone
  falls back to the stock one with a note. The dangerous outcome -- a staging
  site carrying `server_name production.example.com` and answering for it -- is
  structurally unreachable rather than merely avoided.
- **A hostname is not a substring.** `example.com` occurs inside
  `stg.example.com` and inside `notexample.com`. Rewriting it as a substring
  mangles hostnames that merely end in it, and testing for it as a substring
  reports the clone's own name as the source leaking through, which rejected
  every ordinary clone. Both are done on whole-hostname boundaries.

The remaining checks are made before the panel is asked, so a refusal names the
line responsible: the source hostname must not survive anywhere, and every
`server_name` token must be the target or below it. A clone that would answer
for another site is the failure worth spending a gate on.

### Where `clpctl` offers no route, the Stager writes the panel itself

The template route above is only available for PHP. Measured against the
installed 2.5.4-3 CLI: **`site:add:php` is the only `site:add:*` verb with a
`--vhostTemplate` option** -- `site:add:static`, `site:add:reverse-proxy`,
`site:add:nodejs` and `site:add:python` reject it with "the option does not
exist". So for a static or Instatic clone the choice is not between two routes,
it is between writing `site.vhost_template` and shipping a staging site whose
nginx config is not the one being tested.

This is a deliberate, scoped exception to "clpctl is the only thing that writes
panel state", and the test the Instances bullet states still applies: *when
clpctl can be made to do the writing, doing it through clpctl is the rule, not
an exception*. Here it cannot. The exception is bounded by what it is allowed to
touch rather than by good intentions:

- **One `UPDATE`, one row.** `WHERE domain_name = <target> AND type = <type>`,
  on a UNIQUE column, setting `vhost_template`, `application` and `updated_at`.
  Guarded by `SITE_CREATED == 1`, so the row can only ever be one this job
  created seconds ago -- an adopted or pre-existing site is never written to.
- **Run as `clp`, never as root.** The database is `journal_mode=delete`, so a
  write creates a transient `db.sq3-journal` beside it. Made by root, that file
  is left root-owned in a `clp:clp` 0770 directory and the panel cannot recover
  it. `/usr/bin/clpctlWrapper` already runs the whole CLI as `clp`; this matches.
- **Nothing a caller influenced is interpolated into the SQL.** Both written
  values reach sqlite through `readfile()` from staged files, so neither a
  multi-kilobyte nginx config nor an application name is ever escaped into a SQL
  string. Each staged file is `root:clp` 0640 in a `root:clp` 0710 directory --
  the same dance the template handoff uses, and for the same reason. What is
  still interpolated is `<target>`, which has passed `validate_domain` and holds
  nothing but `[a-z0-9.-]`, and `<type>`, which is one of three literals.

  This bullet used to claim only the *body* went through `readfile()`, and the
  claim was load-bearing while being incomplete: `application` was interpolated
  too, in both the `UPDATE` and the read-back. That value originates in the
  **source** site's `site.application`, and CloudPanel puts no character
  validation anywhere on the path to it -- `VhostTemplateAddCommand` stores
  `trim($input->getOption("name"))` as given, `SiteAddPhpCommand` copies that
  name into `site.application` verbatim, and `/etc/sudoers.d/cloudpanel` grants
  *every* local account `NOPASSWD: /usr/bin/clpctlWrapper`. Reproduced against a
  throwaway database by running the real function: an application of
  `Generic', user = 'root` rewrote `site.user` to `root`. Worse, the read-back
  runs `sqlite3 -readonly` **as root** and this build has `fileio` compiled in,
  so `SELECT writefile('/tmp/x', ...)` under `-readonly` created a root-owned
  file -- an arbitrary root write reachable from a template name.

  So `application_ok` refuses any name outside `[A-Za-z0-9 ._-]` (measured, not
  guessed: every stock template name on this box and every `site.application`
  value in its `site` table uses only letters, digits, space, dot and hyphen,
  with `PrestaShop 1.7` forcing the dot and `clp-stager-src2` the hyphen), a
  source whose name fails it is cloned from `Generic` with a note rather than
  refused, and `readfile()` is what makes the statement safe even for a value
  that somehow got past the check. `vhost_template_exists` answers "no" for such
  a name instead of doubling the quotes in it, which was sanitizing the one kind
  of input the rules here say to reject.
- **Read back and compared** inside sqlite against the same files, so it is a
  byte comparison of the columns rather than of two shell variables command
  substitution has already trimmed. It fails closed.

**The renderer is learned, not reimplemented.** CloudPanel's rendering is pure
`{{placeholder}}` substitution -- `Template::build()` runs each placeholder's
processor and `removeEmptyPlaceholders()` blanks the rest -- and there is no
console command that re-renders a vhost from the database. Rather than hardcode
a processor list a panel update can change, the addon splits the *clone's own*
freshly stored body on its placeholders and walks the file the panel wrote for
it seconds earlier, matching literal segments in order. What lies between two
literals is the preceding placeholder's value. It copies whatever this panel did
to this site a moment ago.

That is only sound because it refuses rather than guesses. The walk must consume
the rendered file exactly to EOF; a placeholder appearing twice must resolve
identically both times; two placeholders with nothing between them are refused
rather than split at an arbitrary point; the whole parse is done again from the
other end and the two readings must agree; and a placeholder in the composed body
the map does not know is a refusal, never an empty string. Blanking it the way
the panel does would turn an unknown `{{root}}` into a server block with no
document root, which nginx accepts and serves as the wrong thing.

The second-reading guard is the one the others cannot be. Read forwards, a value
is the *shortest* string that reaches the next literal, so a wrong guess normally
surfaces as a later literal failing to match -- except when that literal also
occurs inside the first placeholder's value, where the short reading and the long
one both consume the file to EOF and both look clean. Read backwards the value is
the longest instead, so a unique parse gives the same map twice and an ambiguous
one does not.

`{{ root }}` is not `{{root}}`, and treating it as the same was a bug rather than
a convenience. `Template::getPlaceholders()` matches `/{{[\sa-zA-Z0-9_]+}}/`, so
the panel *recognises* the spaced form -- and then never fills it, because
`Processor::$placeholder` is the exact string `{{root}}` and `replace()` is a
plain `str_replace`. It survives every processor and `removeEmptyPlaceholders()`
blanks it. Folding the whitespace away here produced a rendered file holding a
`root` directive and a stored body the panel will regenerate without one: `nginx
-t` passes, the clone serves, and the document root disappears the next time
anything touches the site. Both directions refuse it by name instead.

**Install order is file first**, and that ordering is the whole safety argument.
The rendered config is written and `nginx -t`-ed before the database is touched,
so the row the panel would regenerate from is never left describing a config
nginx rejected; nothing is reloaded until both have succeeded, so a bad config is
never served; and every failure restores the backup. The worst outcome is a
working clone on the stock vhost plus a note saying why -- never a missing clone
and never a broken nginx.

**It carries vhosts the template route has to refuse.** The `{{server_name}}`
requirement exists only because `vhost-template:add` demands the placeholder, and
this path does not go through that verb. So the gap listed below -- a source
whose `server_name` line is itself the hand edit -- is closed for every type,
because a PHP source the template route refuses now falls through to this one.
The two real checks are unchanged and are what the gate still is: the source
hostname must not survive anywhere, and every `server_name` token must be the
target or below it.

## Cloning an Instatic site means cloning the application, not the hostname

A reverse-proxy site's backend is a port. Cloning the site alone gives a second
hostname pointing at the *same* container -- a staging site that edits production
content, which is the one outcome a staging tool must never produce. So the
reverse-proxy path starts by establishing that the backend is an Instatic
instance this box manages: `/var/lib/clp-addons/instatic/<source>/meta.json`
exists, **and** the panel's own `site.reverse_proxy_url` is that record's port on
the loopback. Either alone is not enough -- a record outlives a site that was
repointed, and a loopback URL says nothing about what is listening on it.
Anything else is refused by name, with nothing created.

The content then moves through **Instatic's own site-bundle export and import**,
never through its files. Reaching into an instance's `data/` and `uploads/` would
freeze this addon against one version of a schema it does not own, and drag the
source's master key and sessions along with the content. The bundle is the
supported interface and survives Instatic's own migrations.

What makes the bundle the *right* transfer is what it leaves behind: the site
shell, tables, rows, media, folders and redirects travel; **no users and no
secrets do**. So the clone gets its own `INSTATIC_SECRET_KEY`, its own owner and
its own sessions, and nothing encrypted at rest crosses between two instances.
The cost is stated in the job rather than papered over: per-instance integration
secrets are encrypted under the source's key and must be re-entered, and absolute
links typed into a page still name the source -- the env-level origin is correct
on the clone, but rewriting content would need bundle-schema knowledge, which is
the same line the WordPress search-replace step draws.

Three details decide whether it works at all:

- **Both of the source's credentials are on stdin, never in argv.** Anything
  passed as an argument is readable out of `ps` by every account on the box, and
  worse: `sudo` journals this wrapper's whole `COMMAND` line, verified against
  this box's own journal, so an argument outlives the process entirely. The
  authentication code was an argument until that was measured, and it is the one
  that mattered most -- `validate_mfa` deliberately accepts a *recovery* code,
  which does not expire, so a permanent second factor was being written into the
  persistent journal. Both now cross as one line each on the same channel.

  They are stored 0600 in the job directory, which is where they have to live
  because `run` is started by `systemd-run` and inherits no stdin, and both are
  deleted the moment the sign-in they exist for has succeeded -- not after the
  export, which is the long step and needs neither. The Instatic addon already
  refuses to put its master key in `docker run -e` for this reason.

  Line framing across two secrets is only sound because a newline inside either
  is refused rather than trimmed. `IFS= read -r` used to stop at the first one,
  so a password containing a newline arrived shortened and produced a 401 --
  spending the production account's lockout budget on a value the operator never
  typed.
- **What the job leaves behind is part of the design, including when it fails.**
  A failure between login and export used to leave a live administrator session
  on the *production* instance -- Instatic's absolute timeout is 90 days -- with
  its token in a cookie jar the job directory kept for `JOB_RETENTION_DAYS`. The
  rollback now revokes every session the run opened and removes both jars, so
  "a clone leaves nothing live on the site it copied" holds on the path where it
  matters most. A job `systemd-run` refuses to start deletes its credentials too;
  that record is marked failed and then kept for the full retention window.
- **Files curl creates are made before curl creates them.** `curl` writes its
  output and its cookie jar with the process umask, and `run` inherits the unit's
  `UMask=0022`, so a live session token and a full export of a customer's site
  appeared as 0644 among files that are otherwise 0600 -- the export for the
  whole length of the download, because the `chmod` only ran once it finished.
  Each is created empty and 0600 first; `-o` and `-c` truncate rather than
  recreate, so that is the mode they keep. The 0700 job directory is the other
  half of this, and neither is a substitute for the other.
- **Every mutating request carries an explicit `Origin`.** Instatic runs a CSRF
  origin check against its configured `PUBLIC_ORIGIN`, and these requests arrive
  on `127.0.0.1` rather than on the hostname. Sessions ride in a curl cookie jar
  rather than a cookie name written down here, because the name is Instatic's to
  change.
- **The import is `strategy=replace`.** The public one-shot `setup` endpoint
  seeds a starter homepage, and a merge would leave it beside the imported pages;
  replace is what makes the clone match its source rather than merely contain it.
  It is also the highest-blast-radius operation Instatic has, so it wants
  `data.import` plus `content.manage` plus an open step-up window -- which is why
  the clone signs in and opens one rather than importing straight after setup.

The session on the source is revoked rather than left to expire. A clone should
leave nothing live on the site it copied.

Node.js and Python sites are deliberately not clonable. Both are a `site:add:*`
verb away, but neither exists on the box this was built against, and an untested
clone path that creates real sites is worse than an honest refusal.

**The handoff file is root:clp 0640 in a 0710 root:clp directory.**
`/usr/bin/clpctlWrapper` ends with `su -s /bin/bash -c "$COMMAND" clp`, so
clpctl reads `--file` as the `clp` user, not as root. A template written into a
job directory, which is 0700 root, reached the panel as an empty file and was
rejected as such. This applies to every path handed to `clpctl`, not just this
one.

**The base template is checked before it is used.** `site.application` records
the *name* a site was created from, not a reference to it, so that template can
have been deleted or renamed since. Falling back to one that is gone fails
`site:add:php` with "does not exist", which is a confusing way to lose a clone;
a missing one falls back to Generic and says so.

## A release tree has to serve every installed addon (superseded)

**Superseded.** The `current` symlink / `releases/<tag>` / `placeRelease`
mechanism this entry describes is gone entirely: there are zero matches for
`placeRelease`, `pruneReleases`, `releaseArtifacts` or `addonIsAtRelease`
anywhere in the tree. See "Current architecture -> Active artifact layout and
updates": there is one active binary at `/usr/local/bin/clp-addons` and no
release directory or `current` symlink in a live install. Kept for the
`status=203/EXEC` failure mode it documents, which is the reason a shared
release tree was worth removing rather than merely patching again.

`current` is a symlink shared by every addon: each service unit ExecStarts the
binary in `current`, and needs its own wrapper beside it. `install` fetched the
artifacts for the addon being installed, wrote them into a new release directory
and moved `current` onto it.

With one addon that is correct. With two it took the other addon's files out
from under its own unit, and the symptom was `status=203/EXEC` on a service that
had been running for weeks, produced by installing something else entirely.
`update <one addon>` had the same shape.

Merging the app binaries into one artifact narrowed this but did not remove it:
the binary is now shared, but each addon still has a wrapper of its own in the
release tree, so the obligation is the same one directory down.

Both now fetch the artifacts of every installed addon, not just the one named,
and `placeRelease` refuses to move `current` onto a directory that is missing
any of them. The guard lives with the symlink swap rather than in the callers,
because every caller of it has the same obligation.

## One snapshot, one shared group

`snapshot.json` is the panel's sanitized site list, written by root and read by
the manager. It was `root:<that addon's site user>` 0640, which was right for
one addon and silently wrong for two: installing the second chowned the file to
its own user and the first addon's dashboard lost its site list.

**The permission facts below are still exactly true; only "every addon's site
user joins it" is stale**, because there is no longer an addon site user to
join anything. There is one service account whose primary group already is
the shared group. `SHARED_GROUP` is `SERVICE_GROUP` is `"clp-addons"`
(`cli/paths.ts:14-17`), `STATE_DIR` is `chown root:${SHARED_GROUP}`
(`cli/provision.ts:307`), and `snapshot.json` is chowned the same way
(`cli/provision.ts:320`). See "Current architecture -> Identity and socket
permissions" for the account. `install`/`repair` regenerate the snapshot for
every installed addon rather than leaving it to the next timer tick, since
otherwise installing one addon would take another one's site list away for up
to fifteen minutes.

The group is the smallest thing that fixes it. The file holds the panel's
non-secret site list, which does not justify anything more elaborate.

## An existing site is adopted only when it is already the right proxy

`cmd_create` and `ensureAddonSite` both adopted any CloudPanel site whose
hostname matched, rather than failing. That is right for a reverse proxy already
pointing at the port in question and wrong for every other kind of site.

The failure it produced was silent, which is the reason this is written down.
Point either at an existing `static` or `php` site and the container starts,
binds its port and answers on `127.0.0.1` -- and then the health check's second
probe, the one that goes through nginx on the real hostname, reaches the site
that was already there and gets a 200 from it. Create reported success and wrote
`meta.json` for an instance nothing routes to. No probe through nginx can tell
the two apart, because the wrong site answers exactly like the right one.

The panel records both facts that do tell them apart: `site.type` and
`site.reverse_proxy_url`. Adoption now requires `reverse-proxy` and a URL equal
to `http://127.0.0.1:<port>`, and refuses with what it found instead.

This mattered immediately rather than hypothetically: migrating an existing
static site to an Instatic instance under its own hostname is the ordinary way
someone arrives at this code path.

## The state directory belongs to root

`ensureDirs` gave each addon's state directory to the addon's site user. Nothing
needed it: the manager reaches every one of those files through the wrapper, and
the only reader on the filesystem is `lib/panel-snapshot.ts`, which runs as
root. The ownership dates from when the manager kept an `app.db` of its own
there; that file was removed in the same refactor that made the wrapper's files
the only record, and the ownership stayed.

What it bought was a way around the wrapper. Owning the parent directory is
enough to rename a root-owned child aside and put your own in its place, so the
manager's account could substitute the wrapper's own records -- `jobs/` for the
stager, an instance directory for instatic -- and every path the wrapper derived
from those records became caller-controlled. That is the one thing the privilege
boundary exists to prevent.

Root-owned closes it at the source. Two read-back paths were tightened in the
same pass, because a boundary should not depend on a directory mode alone:

- `cmd_update` validated neither the tag nor the port it read from `meta.json`,
  while `cmd_recreate`, reading the same file, validated both. The tag becomes a
  path component of the pre-update snapshot, which `tar` writes as root.
- the stager's `run` verb built its lock path from the job record's `target`
  before `cmd_run` re-validated it. The instatic wrapper already states the rule
  -- derive a lock path only from an already-validated domain -- and a value read
  back off disk is owed it as much as one that arrived in argv.

Instance subdirectories are still owned by each instance's own site user, and
this is still not a recursive chown: `repair` calls it every fifteen minutes,
and a `chown -R` would take every container's database away on that schedule.

## Deletion archives are not a rolling window

`make_snapshot` ended by pruning its own output directory to the five most
recent archives. For an instance's `snapshots/` directory that is right -- those
exist to roll back the update that just happened. For the pre-delete archive it
is data loss, because `cmd_delete` writes into `/var/backups/clp-addons/<addon>`,
which is shared by every instance and holds one archive per deleted instance,
each the last copy of data whose CloudPanel site is already gone.

So the guarantee the README states -- each instance archived before it is purged
-- quietly expired after the fifth deletion. Worse, `uninstall --purge` deletes
instances in a loop, so on a box with six or more it destroyed archives it had
written itself earlier in the same run.

Pruning now belongs to the two verbs whose output directory really is a rolling
window, `update` and `snapshot`. `make_snapshot` writes the archive and stops.

## Unattended repair must not fail when no panel session exists

`ensureDirs`'s second argument, `verifySession`, calls `ensurePanelSessionReadable`
(`cli/provision.ts:253-290`), which requires a currently existing `sess_*` file under
the PHP session directory, owned by the panel user and readable by the service
account. The check exists for `install`: a human runs it, sees a clear failure, and
can act on it -- an unreadable session there means the addon's CloudPanel SSO
integration cannot work.

`cmdRepair` called `ensureDirs(all, true)` unconditionally, the same hard-fail check
`cmdInstall` uses. But `repair` is not only run by an operator -- it is also the body
of `clp-addons-reconcile.service`, fired by `clp-addons-reconcile.timer` every fifteen
minutes (`OnCalendar=*:0/15`, `cli/provision.ts:469`), with nobody watching its exit
code. Whenever no operator happened to be logged into the panel UI at that moment --
which is the common case, not the exception, on most boxes most of the time --
`ensurePanelSessionReadable` found no session file, `fatal()` threw, and every
reconciliation step after it never ran: `writeConfig`, `hardenBackups`,
`removeLegacyUnits`, `removeLegacyUsers`, `installSudoers`, `installUnits`,
`generateSnapshot`, `startUnits`/`ensureTimerArmed`, `reconcileAnchors` and
`reconcileNginx`. This reproduced on every installed panel; every fifteen minutes, the
self-healing pass silently did nothing. Only `clp-addons-anchor.path` ->
`repair --anchors-only` kept working, because that branch returns before the session
gate is ever reached (`cli/index.ts:309-311`).

`repair` now calls `ensureDirs(all)` (no session check) and separately
`warnIfPanelSessionUnreadable()` (`cli/provision.ts:298-309`). That wrapper runs the
identical check but turns a failure into `log.warn` instead of `fatal`, so an
unreadable session is recorded in the journal instead of aborting the run -- and it
cannot itself abort, whether the session file is merely missing or the whole session
directory does not exist. `log.warn` writes through `console.warn` unconditionally; it
is not gated by `--quiet` anywhere in this codebase, so the warning still reaches the
journal from the timer's `repair --quiet` invocation. `install` is unchanged: it still
calls `ensureDirs(specs, true)` and still fails loudly when no session exists, because
there a human is present to see it and act.

## The panel vhost is panel-owned, and that is not a defect

CloudPanel 6 runs the panel on a second Nginx instance: config root
`/home/clp/services/nginx/nginx.conf`, vhost
`/home/clp/services/nginx/sites-enabled/cloudpanel.conf`, unit `clp-nginx`,
with the distro instance still serving the site vhosts out of
`/etc/nginx/sites-enabled`. Earlier layouts put the panel vhost in the distro
tree. `nginxLayout()` (`cli/paths.ts`) detects which one an install has by
looking for the panel tree, not by parsing a version string -- both layouts are
in the field and the version does not distinguish them -- and the resolved
layout drives vhost discovery, `nginx -t -c`, and the reload target. Testing or
reloading the wrong instance is silently wrong: the distro `nginx -t` never
reads the panel's config, so it passes on a broken panel vhost.

The whole panel tree, config root included, is `clp:clp 0770`. The installer
used to require the vhost to be root-owned and refused to install because of
it. That requirement is now "owned by root or the panel user, and not
world-writable" (`vhostOwnerAccepted`, `cli/provision.ts`).

The reason is that the requirement was never buying anything here. The panel
user is already inside this project's trust boundary, twice over and by design:

  - the manager socket is group `clp`, mode 0660, which is how Nginx reaches
    the daemon -- so the panel user can talk to it directly and never touch the
    vhost at all;
  - the session files `action auth` reads to decide who a request is are
    panel-owned, so the panel user can write a session that comes back
    `ROLE_ADMIN`.

An actor holding either of those does not need to rewrite a vhost. Refusing to
install because the panel owns its own configuration would have cost every
current CloudPanel an install to defend against nothing. What the check still
refuses is the case it was really aimed at: a vhost any local user can rewrite.

What replaces the ownership guarantee is not a permission but a reconciler.
`reconcileNginxProxy` records the hash of the vhost with our block stripped, so
it can tell the two drift cases apart: if only our block was removed the
stripped content still matches, and it re-renders, writes, tests and reloads --
the block comes back on its own. If the surrounding config also changed, the
stripped hash differs, and it reports `upstream-changed` and writes nothing,
because the recorded baseline no longer describes the file. A CloudPanel
upgrade that rewrites the vhost is exactly that second case and wants a human.

For the reinsertion to be prompt rather than up to fifteen minutes late, the
resolved vhost joins the addon templates in the `.path` unit's watch set
(`reconcileWatchPaths`, `cli/provision.ts`), and the watcher's
`repair --anchors-only` fast path now reconciles the proxy as well as the Twig
anchors. Both reconcilers no-op when nothing drifted, which is what keeps that
safe to fire on every write during a package upgrade.

Detection, not prevention, is the honest ambition: someone holding `clp` could
rewrite the vhost, use it, and put it back inside the window. But prevention
was never on the table against an actor that already has the socket and the
session store, and continuous reconciliation is strictly more than the
ownership check ever gave.

## The root auth helper is reached by socket activation, not sudo

The manager runs as `clp-addons` and the panel's session files are `clp:clp`
0600, so it cannot read them: deciding who a request is has to happen in a root
process. That process is the same single binary, invoked as
`clp-addons action auth`, speaking one bounded line of stdin and one bounded
JSON line of stdout. What changed is only how the daemon reaches it.

sudo cannot be that path. The manager's unit sets `RestrictAddressFamilies=`
and `ProtectKernelTunables=`, and each of those implies
`NoNewPrivileges=yes`, which systemd does not allow a unit to turn back off.
Under `NoNewPrivileges` sudo refuses to escalate at all -- it reports "the no
new privileges flag is set" and exits 1. The first build shipped the sudo call
and every authenticated request came back 503 on the test box, with the
sandbox doing exactly what it was configured to do. Keeping sudo would have
meant dropping both properties from an internet-facing daemon, and leaving a
trap: re-adding either one later would silently break authentication again.

So the connection is inverted. `clp-addons-auth.socket` listens on
`/run/clp-addons/auth.sock` as `root:clp-addons` 0660 with `Accept=yes`; the
manager connects as itself, and systemd starts `clp-addons-auth@.service` as
root with that connection as the helper's stdin and stdout. `Accept=yes` is
what makes this fit: the helper's existing one-shot stdin/stdout contract is
already what a per-connection service speaks, so no protocol was added and no
second artifact exists -- the socket unit's `ExecStart` is the same
`/usr/local/bin/clp-addons`.

One protocol detail this forces: the helper stops reading at the request's
newline rather than at EOF. Under socket activation stdin is the connection,
and the caller holds it open waiting for the reply, so reading to EOF
deadlocks until the client's two-second timeout.

The client treats every failure -- connect error, timeout, oversized reply,
unparseable reply -- as `unavailable`, which becomes 503. The one thing it
never does is treat a failed lookup as an authenticated request.

When this was written, `sudo` was still used for addon actions
(`clp-addons action instatic|stager`) and only the authentication path had
moved. That is no longer true: the gateway grew an `action` request kind, the
addons' verbs moved onto it, and the sudoers drop-in was removed outright. The
manager now holds no sudo rule for anything. What remains of sudoers in this
tree is the code that deletes a drop-in left by a version that predates the
gateway.

## The manager enables addons and applies releases; it never updates itself

Three related questions came up together: should the manager update itself
automatically, should the release notice grow a button, and should the addons an
install does not have be visible at all. The answers are no, yes, and yes, and
they are one decision because the first is what makes the other two safe to
offer.

**No automatic updates.** This project writes `/etc/nginx`, the panel's own Twig
templates, systemd units, and installs a root gateway daemon. An unattended pull
from GitHub means that whoever controls the release pipeline -- or a leaked
token, or a force-pushed tag -- gets root on every install, silently, with
nobody in the loop. The SHA-256 verification in `fetchVerified` does not help
against that: the checksums are served from the same release the checksums are
verifying, so an attacker who can publish a release can publish matching sums.
`gh attestation` raises the bar, but the decision not to act unattended is not
about how good the verification is; it is about who decided. Two supporting
reasons: CloudPanel itself does not auto-update, and matching the panel's
behaviour is an explicit goal of this project; and replacing the binary restarts
the manager, which would drop in-flight requests on the manager socket at a
moment nobody chose. So the manager notifies and stops there -- `checkCliUpdate`
and the shared header controls in `renderLayout`.

**A button, once the page behind it is administrator-only.** With the
administrator gate at the socket boundary (`adminGate` in `cmdServe`) every
route the manager serves is already restricted to `ROLE_ADMIN`. The header's
"Changelog" link opens the release notes; "Update" opens `/addons/update` for
version details and an explicit "Install update" action. The update page is not
a new trust boundary; it is the notice the manager already drew, with the
command the operator would have typed attached to it. It reuses
`cmdUpdate` outright rather than growing a second downloader: one verified
download path, or eventually two that disagree about what verification means.
`guardMutation` applies the same origin and CSRF checks the addons use, so
another origin cannot spend an administrator's session on a binary replacement.

**"Available" addons are enabled, not installed.** `ADDONS` in `cli/paths.ts` is
a compile-time record and each addon's injection targets are imported TypeScript
values, so every addon already ships inside the binary of every install. What
`install.sh --addons=instatic,stager` selects is which of them are *configured*.
Making that visible costs almost nothing -- the registry is already in memory --
and it turns a binary that quietly contains an addon the operator has to read
the install documentation to discover into one that describes itself. Enabling
writes the config file, injects the Twig anchors and reinstalls the units;
disabling withdraws all of that and keeps the addon's state directory, so
enabling it again returns the same instances.

Disabling *every* addon is allowed, and making it allowed took three changes.
`serve` used to exit when nothing was configured, which meant the last disable
killed the only surface that could undo it; serving nothing is now a legitimate
state, because every addon is compiled in and a manager with none of them on is
exactly the page that offers them back. `repair` used to refuse the same state,
which would have left the timer, the Nginx proxy and the anchors unreconciled
for as long as an install sat empty; it now refuses only when no manager is
installed at all. And the panel's "Addons" entry used to be derived from "at
least one addon is enabled" -- the same thing until that entry became the way
back to the page, at which point disabling the last addon hid the link to the
only place that could re-enable it. The entry now belongs to the installation
and goes when `cmdUninstall` says the installation is going. Removing an install
is still `clp-addons uninstall`, which runs from a shell that survives it.

**All three are jobs, because all three restart the manager.** Enabling,
disabling and updating end in `startUnits()`, which restarts the very process
that asked for the work; none of them can answer the request that started them.
So the create path writes a job record under `/var/lib/clp-addons/manager/jobs`,
hands the work to a transient systemd unit that outlives the restart, and
returns a job id. The record is the report: state, step and error are on disk
before the runner exits, the page's poller tolerates the window where the
manager is down, and when it comes back the index page reads the newest record
and shows what happened. That is also what makes the buttons idempotent -- a
second click finds the first click's job through `activeManagerJob` and follows
it instead of starting a second enable. The job runner itself is deliberately
absent from `MANAGER_ALLOWED_VERBS`: reaching it through the gateway would skip
exactly that check.

**No search.** Search across two addons is worse than a list: more chrome, no
benefit. The signal to revisit it is the list feeling crowded, somewhere around
eight or ten addons, not the feature being conceivable.

## Bundled addon activation and the release trust bootstrap

The default CLI `install <addon>` now follows the same bundled activation path
as Enable in the UI. Every addon already ships in the binary, so configuring
one must not fetch the latest release or require GitHub CLI. This also restores
CLI activation after every addon has been disabled. Explicit `install --version`
and `update` still verify downloaded artifacts; `install --local` still checks
the caller's local checksums. Disable and uninstall do not fetch releases.

GitHub CLI has two installation paths for a reason. The shell bootstrap needs
it before the downloaded `clp-addons` executable can safely run as root. The
binary's `ensureGh` also owns recovery during subsequent artifact verification:
prefer the private helper, then an attestation-capable PATH helper, otherwise
download the official CLI tarball and verify its published checksum. Probe the
candidate in a private directory on the destination filesystem before an atomic
rename, preserving the old verifier if any step fails. Attestation of the addon
release remains mandatory unless explicitly skipped.

## Session readiness and startup after a reboot

Session readiness no longer requires an exact `clp:clp 0770` directory. A
reported `clp:clp 0755` directory was rejected even though the root gateway can
read it. Accept root or panel ownership and modes whose writers are restricted
to root and the panel group; retain rejection of symlinks and untrusted writers.
Do not chmod CloudPanel's tree or require a live session. The per-request file,
owner, size, expiry and authentication checks remain in the root helper. This
supersedes the earlier directory/readability assumptions in this document.

The reported reboot 502 was a systemd `226/NAMESPACE` failure: the manager's
`ReadWritePaths` listed `/run/lock/clp-addons`, which only provisioning had
created and reboot removed. The manager never uses those locks; the root action
processes create the directory when they need it. Remove it from the manager's
namespace requirements. The manager's `RuntimeDirectory` creates its own socket
directory at every start. Order it after the authentication socket, whose
`DirectoryMode` creates the parent without competing for its runtime ownership
or lifetime. These rules apply to an empty manager as well as an enabled one.

## Known gaps

- `--local` installs skip provenance verification by construction. Staging only.
- Only `x86_64` is built. `recon.sh` confirmed `avx2` on the target, so the
  standard glibc target applies rather than the baseline variant.
- Snapshot archives written under an instance's `snapshots/` before the mode was
  set explicitly keep their old 0644. They are protected by the 0700 directory
  above them, so this is untidy rather than exposed, and `repair` deliberately
  does not walk instance directories -- those belong to the action module.
- The Stager addon does not delete a staging site. CloudPanel already does, from
  Site -> Settings, and deleting a site is where a mistake costs the most; a
  second button for it would be a second way to get it wrong.
- URL rewriting inside a cloned database is WordPress only, through `wp-cli`.
  A Laravel or Symfony clone gets its `.env` credentials rewritten but nothing
  reaches into its database, so anything storing an absolute URL there still
  names the source site.
- A clone's Instatic content is whatever the source's site bundle held at export
  time. Absolute links typed into a page still name the source; per-instance
  integration secrets are absent by construction; plugins and the runtime assets
  a publish produces are not in the bundle either, so a clone of a *published*
  source serves pages whose `/_instatic/assets/*` 404 until it is published
  again, and a source with plugins yields a clone with none. And the export is
  scoped to what the exporting account may see: Instatic gates that on
  `content.manage` through `canSeeAllDataRows`, so an account without it exports
  only its own rows and still answers 200, producing a clone that is missing
  other authors' pages and looks complete. Every one of these is reported as a
  note on the job rather than left to be discovered.
- A clone copies the source's files and database as they are at that moment.
  There is no quiescing: a site written to during the copy can produce a staging
  copy whose files and database are from slightly different instants.
- A site user's password and a staging database's password reach `clpctl` as
  command-line options, where any account on the box can read them out of
  `/proc/<pid>/cmdline` for as long as the process runs. This is the one place
  the project's own rule -- secrets on stdin or in an `--env-file`, never in
  argv -- is broken, and it cannot be fixed here: `site:add:*` declares
  `siteUserPassword` as a Symfony `InputOption::VALUE_REQUIRED` and reads it
  with `$input->getOption()`, so there is no stdin, environment or file form to
  use instead. Mounting `/proc` with `hidepid=2` closes it at the host level and
  is the only real remedy; the addon does not make that change, because
  remounting `/proc` on someone else's panel host is not its call.
- ~~Each addon needs a hostname of its own, so two addons mean two DNS
  records, two certificates and two Basic Auth setups. Serving both from one
  host would mean either editing a vhost or adding a routing service, and the
  first is forbidden while the second is a new component to keep alive.~~
  **Resolved.** The manager itself is that routing service: one process
  dispatches every installed addon by path (`splitMount`/`MANAGERS`,
  `cli/index.ts:495-497`) and one marked, reconciled `location /addons/` block
  is injected into the panel's own vhost rather than a new one being written
  per addon. See "Current architecture -> Integrated manager and Nginx
  transport".
- ~~The Stager's `prune` verb is not wired into the maintenance cycle
  (open).~~ **Resolved.** `maintenanceVerb: "prune"` was declared on the
  Stager's `AddonSpec` as the intended hook for the fifteen-minute timer
  described under "Reconciliation: a timer plus a path unit" above, but
  `cmdRepair` never read that field and never called `prune`.
  `maintenanceVerb` was dead code: its only two occurrences in the entire
  tree were its own declaration and assignment. The field itself was removed
  from `cli/paths.ts` as dead code during this repo's cleanup pass; that
  removal did not close this gap by itself, because the wiring it was meant
  to support still had not been built. Concretely, this meant that for the
  entire time this gap was open, none of the cleanup `prune` performs
  (fourteen-day job-record expiry, stale-`running` job recovery,
  orphaned-vhost-backup recovery via `recoverCarriedVhosts`) ever ran
  automatically on any panel running this code: job records and their staging
  database passwords accumulated under `/var/lib/clp-addons/stager`, and,
  more sharply, a clone killed by OOM, `systemctl stop`, or a reboot left its
  job record stuck `running` forever -- and since `cmdClone` refuses to clone
  into a target that already has a `queued` or `running` record, and only
  `prune` clears a stuck `running` one, that permanently blocked re-cloning
  the same hostname until an operator ran `clp-addons action stager prune`
  by hand. Wiring `prune` into `repair` was deliberately left as future work
  during that cleanup pass rather than folded into it, so that a behavior
  change was not smuggled into a docs-only commit; this entry recorded that
  gap so it would not be forgotten. It has since been wired: `cmdRepair`
  (`cli/index.ts:305-344`) now calls `runStagerMaintenance`
  (`cli/index.ts:295-303`), gated on the Stager addon being installed, after
  the Nginx proxy reconciliation and with its own failure caught and logged
  rather than allowed to fail the rest of `repair`. The original intent was
  the right design all along: one fifteen-minute timer already exists, so
  addon maintenance hangs off it rather than a second timer per addon.
