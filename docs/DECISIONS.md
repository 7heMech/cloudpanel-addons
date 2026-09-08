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

## One CloudPanel site for every addon, routed by path

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

So there is one artifact. `clp-addons` is the CLI; `clp-addons serve <addon>` is
that addon's manager, and the systemd unit ExecStarts that rather than a binary
of its own. 81.4 MB total, and an addon now costs its wrapper script.

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

`serve` is also the one verb that is deliberately not `requireRoot`. It runs as
the addon site's own CloudPanel account; its single privileged path is sudo of
its own wrapper.

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

`tools/test-inject.ts` runs the whole scenario against a throwaway template and
asserts what the old design got wrong: installing the second addon keeps the
first, uninstalling one leaves the other, repeated reconciliation is idempotent
and byte-stable, and removing the last addon restores the original exactly.

Markers written before v0.3.0 had no slug segment. The strip pattern still
matches them, because the first reconciliation after an upgrade would otherwise
snapshot a file with the old block still in it and bake that nav entry into the
pristine copy permanently. Snapshots from the old per-addon keying are deleted
on sight: they have no `.path` sidecar, nothing reads them, and an operator
would reasonably mistake them for current.

## The wrapper's files are the only record of what exists

The manager kept its own SQLite table of instances beside the wrapper's
`meta.json` files. Two records of one fact drift, and these did: an instance
created by calling the wrapper directly never appeared in the dashboard, and a
delete that failed part-way left a row describing something that was already
gone. The table was also the thing `nextPort` consulted, so a drifted row meant
a port handed out twice or never reused.

The files on disk and the running container are the state. The wrapper now has
a `list` verb that walks its own data directory and reports each instance's
recorded metadata with live container state, and the manager holds nothing of
its own -- `app.db` and `db.ts` are gone, along with every write that kept them
in step.

It has to be one call rather than one per instance, because the manager cannot
read those directories: each belongs to its instance's own site user. `list` is
also the one verb exempt from the per-domain lock. It names no domain, so there
is nothing to lock, and locking would mean the dashboard stops rendering
whenever any instance is mid-update -- precisely when someone is looking at it.

Port allocation is now a proposal rather than a reservation: the manager picks
the lowest free port and the wrapper re-checks it under the lock. That is the
honest description of what was always happening, and it no longer depends on a
record only the manager maintained.

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

It is written twice -- once in `cli/provision.ts` and once in the wrapper,
which is bash and cannot import TypeScript. Two implementations of one rule
drift silently, and the failure would be the manager creating a site under one
name while the wrapper looks for another, so `tools/test-app.ts` runs both over
a list of domains and asserts they agree, including the pair that used to
collide.

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

## Authentication is CloudPanel's, not ours

The manager can create and delete sites, so it must not be reachable without
authentication, and the question of where that comes from keeps coming up.
Reusing the panel's admin login was checked properly rather than assumed, and
all three routes are closed:

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
here would have to honour MFA or become the weakest door to the same box.

So authentication is nginx basic auth, and specifically **CloudPanel's own
per-site Basic Auth feature**, not a mechanism of ours. `site.basic_auth_id`
points at a `basic_auth` row, `is_active` is the toggle and `whitelisted_ips` is
the IP allowlist, which covers both things the README asks for. Enabling it stays
a panel action: `clpctl cloudpanel:enable:basic-auth` protects the panel's own
login rather than a site, and writing `basic_auth` rows ourselves would mean
writing an undocumented schema while the panel is running (decision 2.6).

What the addon adds is a read. `status` reports whether the manager's own site is
protected, because that is the precondition the README leads with and the one
command an operator runs to check an install had nothing to say about it. It
tells apart four states, including the one a real box was found in: `auth_basic`
in the vhost with `basic_auth_id` NULL. That does protect the site and survives
regeneration, since the panel rebuilds the vhost from the template the edit lives
in, but the Security tab shows Basic Auth as off, so an operator reading the UI
sees an unprotected site and toggling the switch can rewrite the edit away.

The cost of not reusing the panel login is honest and worth stating: it is a
second credential, not single sign-on.

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

**Job records expire.** A record holds the staging database password, which is
the one credential in a clone that the panel cannot show again and that the
operator needs whenever the application's config could not be rewritten. It is
kept for fourteen days, and `repair` runs the addon's `prune` verb on every
reconciliation -- the expiry has to be something that actually runs, and the
timer that runs `repair` every fifteen minutes already exists. Giving the addon
a timer of its own would be two answers to one question.

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
identically both times; a value is only ever taken as the shortest string that
reaches the next literal, so a wrong guess surfaces as a later literal failing to
match rather than as a plausible wrong answer; and a placeholder in the composed
body the map does not know is a refusal, never an empty string. Blanking it the
way the panel does would turn an unknown `{{root}}` into a server block with no
document root, which nginx accepts and serves as the wrong thing.

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

## A release tree has to serve every installed addon

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
the managers. It was `root:<that addon's site user>` 0640, which is right for one
addon and silently wrong for two: installing the second chowned the file to its
own user and the first addon's dashboard lost its site list.

There is now a `clp-addons` system group. Every addon's site user joins it, the
file is `root:clp-addons` 0640, and each unit names `SupplementaryGroups=` rather
than relying on how systemd treats an account's group list. `install` brings
along the addons already installed rather than leaving them to the next timer
tick, since otherwise installing one addon takes another one's site list away
for up to fifteen minutes.

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

## Known gaps

- `--local` installs skip provenance verification by construction. Staging only.
- Only `x86_64` is built. `recon.sh` confirmed `avx2` on the target, so the
  standard glibc target applies rather than the baseline variant.
- Snapshot archives written under an instance's `snapshots/` before the mode was
  set explicitly keep their old 0644. They are protected by the 0700 directory
  above them, so this is untidy rather than exposed, and `repair` deliberately
  does not walk instance directories -- those belong to the wrapper.
- The Stager addon does not delete a staging site. CloudPanel already does, from
  Site -> Settings, and deleting a site is where a mistake costs the most; a
  second button for it would be a second way to get it wrong.
- URL rewriting inside a cloned database is WordPress only, through `wp-cli`.
  A Laravel or Symfony clone gets its `.env` credentials rewritten but nothing
  reaches into its database, so anything storing an absolute URL there still
  names the source site.
- A clone's Instatic content is whatever the source's site bundle held at export
  time. Absolute links typed into a page still name the source, and per-instance
  integration secrets are absent by construction. Both are reported as notes.
- A clone copies the source's files and database as they are at that moment.
  There is no quiescing: a site written to during the copy can produce a staging
  copy whose files and database are from slightly different instants.
- Each addon needs a hostname of its own, so two addons mean two DNS records,
  two certificates and two Basic Auth setups. Serving both from one host would
  mean either editing a vhost or adding a routing service, and the first is
  forbidden while the second is a new component to keep alive.
