# Decisions

Why the code is shaped the way it is. Where something here says a decision is
settled, don't relitigate it in code — argue it here first.

## The wrapper is the whole security model

`addons/*/wrapper/clp-action-*` runs as root via one sudoers line. Everything it
permits, the unprivileged app account can do as root. The account's isolation is
worth exactly as much as the wrapper's argument validation is strict, so that
file is the one to review line by line.

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
  `NOPASSWD: /usr/bin/clpctl *` is equivalent to full root.
- **stdout is a contract**: exactly one JSON object. Progress goes to stderr.
  Never scrape prose for meaning.

### `set -e` in the wrapper, specifically

Two silent failures have come from the same shape:

```bash
foo() {
  [[ cond ]] && emit_err "..."     # returns 1 when cond is FALSE
}
foo "$x"                            # set -e: exits, with no output at all
```

A trailing `&&` list returns non-zero on the *success* path. The function then
returns non-zero, and `set -e` aborts the script producing nothing — which is
indistinguishable from a no-op. Use `if`, and end validators with `return 0`.

The same applies to `pipefail`: `x=$(cmd | tr ...)` aborts the assignment when
`cmd` exits non-zero, even though the pipeline produced the value you wanted.
Add `|| true` where a non-zero exit is expected.

`tools/test-wrapper.sh` asserts that every verb with valid input *emits
something*, which is what catches this class. A rejection-only test suite does
not — the bug lives on the success path.

## Placement: the addon is its own CloudPanel site

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

## The manager runs as CloudPanel's site user

Decision 2.4 says the addon runs as the site user CloudPanel creates. An earlier
version created a dedicated `instatic-app` account instead, which meant two
accounts existed for one addon site and uninstall had its own user to clean up.
The site user is now resolved from the panel database after the site is created,
and the legacy account is removed on install and repair.

CloudPanel gives site users a login shell and a password so operators can reach
the docroot over SFTP. For this site that is a liability rather than a feature:
it is a pure reverse proxy with an empty docroot, and it is the one account
permitted to `sudo` the root wrapper. Left as-is, the site's SFTP credentials —
visible to anyone with panel access to that site — would be a path to root.

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
The failure it prevents is quiet — a container that cannot write its database
still answers `GET /`, so the health check passes and the instance looks fine
until someone tries to save something. `tools/test-wrapper.sh` asserts the
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

## Uninstall reverses install, and says what it will destroy

`uninstall` removes the manager and un-patches the panel but leaves instances
alone, so it cannot become an accidental way to delete a customer's site.
`--purge` is the full reversal, and it delegates each instance to the wrapper's
own `delete` verb rather than reimplementing the teardown: that path already
archives the data, passes `--force` so `clpctl` cannot block on a prompt, and
refuses to delete a site the addon did not create.

Both forms print an inventory naming every instance and site they will touch,
and refuse to act without `--yes`. "and every instance" is not something an
operator can check against what they believe is on the box; a list of domains
is. Whether the manager's own site is removed depends on a marker written at
install time — if the addon adopted an existing site, that site was serving
something first and is left in place.

## The app has no Docker access

Membership in the `docker` group is equivalent to root: a member can start a
container with `/` bind-mounted. The app was briefly in that group so it could
run `docker inspect` and `docker logs` directly, which made every restriction in
the wrapper decorative.

Container state and logs are wrapper verbs (`status`, `logs`) for this reason.
`clp-addons status` reports the group if it reappears; `repair` removes it.

## Systemd sandboxing is deliberately thin

`NoNewPrivileges` is left off, and the usual hardening directives are absent.
This is not an oversight:

- the app's only privileged path is `sudo <wrapper>`, and `NoNewPrivileges=yes`
  blocks sudo outright. `ProtectKernel*`, `RestrictNamespaces`,
  `RestrictAddressFamilies`, `SystemCallArchitectures`, `MemoryDenyWriteExecute`
  and `RestrictSUIDSGID` all imply it;
- namespace directives are inherited by children, so `ProtectSystem` and
  `ProtectHome` would apply to the wrapper too — and the wrapper legitimately
  needs `/home/clp` to read the panel database and `/etc` because `clpctl`
  writes vhosts.

Sandboxing the unit would break the boundary rather than reinforce it. The
isolation that holds is the unprivileged account plus a one-line sudoers rule.

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
  longer matches the expected snippet counts as stale, not present — otherwise
  changing the addon's hostname leaves the nav pointing at the old one forever.
- **Purging the Twig cache is mandatory.** Twig serves the compiled copy until
  the cache is gone.

### Reconciliation: a timer plus a path unit

Reconciliation is a systemd timer, not a dpkg hook: a hook catches apt-driven
updates and misses manual ones, while a timer catches every path including
unattended-upgrades at 6am. It calls `clp-addons repair`, so there is one
implementation of "make the box match what should be installed".

A 15-minute timer means up to 15 minutes with the nav entry missing, so a
`.path` unit watches the two templates and repairs on change. Measured on a
real `cloudpanel.postinst` run with the timer stopped: wiped at 09:36:45,
repaired at 09:36:50.

The watch is a **root-run systemd path unit, not a watcher inside the addon
service**. The obvious idea is that the Bun service is still running during a
panel update and could re-patch the files itself, but `/home/clp` is `0700
clp:clp` — the service account cannot even traverse into it. Giving it the
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
  seeds — a new key leaves every previously encrypted row unreadable. It is
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

## Known gaps

- Instance data directories are `chown 1000:1000` to match the image's `bun`
  user. On CloudPanel uid 1000 is `clp`, so the panel's own user can read an
  instance database. Not an escalation — the container has only its own
  bind mounts — but the uid collision is unintended and worth fixing with a
  dedicated uid.
- `--local` installs skip provenance verification by construction. Staging only.
- Only `x86_64` is built. `recon.sh` confirmed `avx2` on the target, so the
  standard glibc target applies rather than the baseline variant.
