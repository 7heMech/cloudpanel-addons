# Addons UI authorization and capability memo

Status: design proposal based on the checked-in implementation at commit
`7afb021f87565ac241d1fe9376d7f15db50a6431` and the Wave 1 investigation.
This document changes no behavior. Source facts below carry a `file:line`
citation. Runtime facts carry an explicit `Observed in disposable container`
label. Anything neither source nor runtime evidence establishes is labelled
`Unverified`.
All recommendations below describe proposed behavior; their implementation
and runtime guarantees are **Unverified**. The unreleased status and explicit
enable/update product intent are premises supplied in the task.

## Executive answer

**Can a real non-owner use the Addons UI today? The end-to-end answer remains
unverified.** **Observed in disposable container (R3):** CloudPanel supported
a non-owner `ROLE_SITE_MANAGER` account. Neither that account nor the owner
reached the manager UI: both direct socket tests returned `302 /login`.
Both accounts had MFA disabled; neither session contained the MFA-completion
marker the manager requires. The real nginx `/addons/` route was not installed
or tested. These are authentication compatibility results, not evidence of a
role-based denial.

**At the source boundary, yes, conditionally:** a non-owner whose session
passes `authenticateRequest` receives the same index and addon handlers as an
administrator. No role is extracted or checked (`lib/sso-auth.ts:314-365`,
`cli/index.ts:465-480`). A non-admin with such a session can use the privileged
routes, subject to their input validation and separate CSRF requirement
(`lib/app-http.ts:34-67`, `addons/stager/app/index.ts:197-212`). This conditional
answer does not establish that the real panel issues an accepted session.

**Unverified:** real post-MFA session bytes, the surrounding native header
conditions, and a request through the installed nginx proxy are still needed.
The next disposable test must first exercise the unchanged repository against
the package's actual cookie/session configuration. Any diagnostic adaptation
must be reported separately from the as-is result. Production is off limits.

This is a high-severity latent privilege defect in the unreleased version in
scope: any accepted non-admin session would inherit administrator-level addon
capabilities. **Observed in disposable container (R3):** no non-admin exploit
was demonstrated in the disposable setup, because the required end-to-end
session was not obtained. **Recommendation:** authorization must block release
of this SSO UI, including its existing privileged routes, before listing and
update capabilities expand.
That severity conclusion follows from the source capability described below,
not from an observed production incident.
**Wrong if:** a verified supported deployment boundary already prevents every
non-admin request from reaching every privileged route; that would change the
exploitability assessment. No such boundary has been established here.

## Evidence and baseline corrections

Three checked-in details materially change the starting assumptions:

* The current header target produces a separate link for each enabled addon.
  `INSTATIC_TARGETS` calls `headerTarget("Instatic")` (`addons/instatic/inject/targets.ts:11-12`)
  and `STAGER_TARGETS` calls `headerTarget("Stager")` (`addons/stager/inject/targets.ts:33-34`).
  Injection enumeration includes a target only when that addon's config file
  exists (`cli/index.ts:125-137`). Thus the present header is not one generic
  `Addons` entry; it is one `Instatic` and/or `Stager` entry per enabled addon.
* The current sudoers generator names exact wrapper paths from the enabled
  specs (`cli/provision.ts:72-87`), and those paths are
  `/usr/local/libexec/clp-addons/clp-action-instatic` and
  `/usr/local/libexec/clp-addons/clp-action-stager`
  (`cli/paths.ts:63-84`). It does not grant a wildcard `clp-addons action *`
  command. `install`, `update`, `repair`, and `uninstall` remain root-only
  CLI commands (`cli/index.ts:195-198`, `cli/index.ts:241-243`,
  `cli/index.ts:283-285`, `cli/index.ts:381-384`).
* The two committed session fixtures do contain the private `role` and
  `roles` properties and `ROLE_ADMIN` on their reconstructed User payloads
  (`tools/fixtures/session/authenticated.txt:11`,
  `tools/fixtures/session/pending-mfa.txt:11`). Their headers explicitly say
  `SOURCE: RECONSTRUCTED`, identify redacted/reconstructed identity data, and
  say the bytes were not observed from a live panel
  (`tools/fixtures/session/authenticated.txt:1-8`,
  `tools/fixtures/session/pending-mfa.txt:1-8`). Those fields are therefore
  test input, not evidence that a deployed session has that exact shape.

The Wave 1 runtime evidence is kept separate from those source claims:

* **Observed in disposable container (R3):** Debian bookworm CloudPanel
  `2.5.4-3+clp-bookworm` was provisioned. A synthetic owner with
  `ROLE_ADMIN` and an active non-owner `ROLE_SITE_MANAGER` account were created
  through the authenticated UI, and both logged into the panel.
* **Observed in disposable container (R3):** decoding the tokens showed a
  User `role` scalar, a User `roles` array, and an AbstractToken `roleNames`
  array; the owner and site-manager values differed. `firewallName`, `user`,
  and the role-related names were observed on the decoded/reflected objects,
  not verified as raw serialized wire keys. The exact raw property keys,
  ordering, lengths, and serialization layout remain **Unverified**.

  The safely retained decoded values were:

  | Reflected property (not a verified wire key) | Owner | Non-owner |
  | --- | --- | --- |
  | `App\Entity\User::role` | `"ROLE_ADMIN"` | `"ROLE_SITE_MANAGER"` |
  | `App\Entity\User::roles` | PHP array `[0 => "ROLE_ADMIN"]` | PHP array `[0 => "ROLE_SITE_MANAGER"]` |
  | `AbstractToken::roleNames` | PHP array `[0 => "ROLE_ADMIN"]` | PHP array `[0 => "ROLE_SITE_MANAGER"]` |

  **Observed in disposable container (R3):** these values came from
  `unserialize()` followed by reflection in a diagnostic script. They establish
  that role information survived session serialization, but not its exact raw
  key spelling or position. No authentic raw fixture was retained.
* **Observed in disposable container (R3):** both decoded User objects had
  `mfa=false`, and neither session had `_sf2_attributes.mfaAuthenticated`.
  Direct manager UNIX-socket
  requests with the actual CloudPanel cookie returned `302 /login`. Diagnostic
  copies of the authentic session bytes under the repository's expected path
  and presented as `PHPSESSID` also returned `302 /login`.
* **Observed in disposable container (R3):** no nginx `/addons/` proxy route
  was installed, no MFA-complete login was tested, and the native CloudPanel
  Twig navigation context was not inspected. No successful owner or non-owner
  manager UI request was observed in this MFA-disabled configuration. The
  missing MFA marker is sufficient for this source gate to reject a session;
  the observation does not prove that role protection exists or that every
  CloudPanel user is universally blocked.
* **Observed in disposable container (R3):** the stock package used a
  `cloudpanel` cookie and the application's `var/sessions` directory
  (`config/packages/framework.yaml:13-18` in that disposable package), whereas
  this repository uses `PHPSESSID` and `/var/lib/php/sessions`
  (`lib/sso-auth.ts:5`; the repository's session directory is
  `cli/paths.ts:17-20`). This configuration mismatch, together
  with the absent MFA marker and missing proxy, makes the run a caveat rather
  than an as-is end-to-end access result. The stock package's exact config
  values are runtime observations, not claims about the repository.

**Observed in disposable container (R3):** the authentic raw session files from
that experiment were removed. No password hashes, master database credentials,
private keys, or authentication secrets are included in this memo.
**Unverified:** a raw, byte-safe capture from a
MFA-complete disposable CloudPanel session in the repository's expected
layout, and the corresponding real nginx `/addons/` request, are still needed.

## 1. Findings: navigation, request gate, and impact

### Navigation

The injected return value from `headerTarget` is the following markup. The
style block adds the divider and spacing for addon links and the update badge;
the link is the only navigation element, and the script is the client-side
update-notice initializer (`lib/panel-nav.ts:79-91`; its script body is
`lib/panel-nav.ts:3-67`):

```html
<style>
  /* Keep the native 10px margin + 15px padding after the divider, with an extra 20px gap on both sides. */
  .header .nav-link-container .clp-addon-nav { display:inline-block; border-left:1px solid var(--clp-border-color, #eaeaea); padding-left:45px; margin-left:20px; }
  .header .nav-link-container .clp-addon-nav ~ .clp-addon-nav { border-left:0; padding-left:15px; margin-left:10px; }
  .clp-addon-update-badge { display:inline-flex; align-items:center; gap:5px; margin-left:15px; padding:2px 10px; font-size:12px; font-weight:600; color:#10b981; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.35); border-radius:12px; text-decoration:none; vertical-align:middle; transition:all 0.15s ease; }
  .clp-addon-update-badge:hover { background:rgba(16,185,129,0.22); color:#10b981; text-decoration:none; }
  .clp-addon-update-badge .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#10b981; }
  .clp-addon-update-badge .close-btn { margin-left:4px; opacity:0.6; cursor:pointer; padding:0 2px; }
  .clp-addon-update-badge .close-btn:hover { opacity:1; }
</style>
<a href="${url}" class="clp-addon-nav" target="_blank" rel="noopener" title="${label}">${label}</a>
<script>${headerUpdateScript(ver)}</script>
```

There is no `is_granted`, `app.user`, role, or permission condition in this
snippet (`lib/panel-nav.ts:79-91`). The surrounding native CloudPanel Twig
template's conditions for its own navigation items were not inspected in Wave
1. **Unverified:** whether CloudPanel's native header independently hides
items for a non-owner. The synthetic R1 check does not settle that template
question.

The insertion anchor is the native Sites link in
`Frontend/Partial/header.html.twig` (`lib/panel-nav.ts:74-75`):

```twig
<a href="{{ path('clp_sites') }}" title="{% trans %}Sites{% endtrans %}">{% trans %}Sites{% endtrans %}</a>
```

**Unverified:** any enclosing guard around that anchor and the conditions on
CloudPanel's other native nav items. The repository test constructs a synthetic
header (`tools/test-inject.test.ts:27-43`); it is not an observed panel header.

### Request gate

The manager's `/health` path is deliberately returned before authentication
(`cli/index.ts:459-463`). Every other request is sent through
`authenticateRequest` before update lookup, mount dispatch, or the Addons index
(`cli/index.ts:465-480`). The gate has these source-enforced properties:

* It reads `PHPSESSID`, accepts only the restricted session-id character set,
  and reads `sess_<id>` from `/var/lib/php/sessions`
  (`lib/sso-auth.ts:5-12`, `lib/sso-auth.ts:354-362`; the path is
  `cli/paths.ts:17-20`).
* It accepts only a regular, non-symlink session file owned by the CloudPanel
  `clp` UID, with a non-symlink directory and bounded size
  (`lib/sso-auth.ts:61-99`). An absent, malformed, expired, or rejected file
  produces a login redirect (`lib/sso-auth.ts:25-33`, `lib/sso-auth.ts:354-366`).
* It requires integer session metadata, a future expiry, and an exact boolean
  `mfaAuthenticated === true` (`lib/sso-auth.ts:331-345`). The tests explicitly
  reject an absent marker, a string `"1"`, malformed serialization, unknown
  token classes, and a pending-MFA fixture (`tools/test-phase1.ts:91-135`).
* It requires the serialized token to be the exact
  `PostAuthenticationToken` class, the `main` firewall, and an
  `App\\Entity\\User` whose `userName` passes the username grammar
  (`lib/sso-auth.ts:286-300`).
* `PanelSession` contains only `user` and `expiresAt`, and the returned
  `AuthenticatedRequest` contains only `user`
  (`lib/sso-auth.ts:17-19`, `lib/sso-auth.ts:314-317`,
  `lib/sso-auth.ts:354-365`). The parser does not extract or use roles. The
  caller never receives an authorization decision, so an accepted non-owner
  session reaches the same handlers as an accepted owner session.

The CSRF guard is a separate browser-request control: mutating handlers require
same-origin `Origin`/`Host` and a matching double-submit token
(`lib/app-http.ts:34-67`). It does not establish a panel role and cannot repair
the missing authorization decision.

### What an accepted non-admin session can reach

The request router mounts only config-enabled addons and refuses to serve when
none of the enabled specs has a manager in the binary
(`cli/index.ts:450-453`). Once an addon is mounted, the SSO gate is shared by
the index and each manager (`cli/index.ts:465-480`). The source-level blast
radius of one accepted non-admin session is therefore the following:

For the concrete `/addons/stager/` request, `internalPath` strips the outer
`/addons` prefix and `splitMount` selects the `stager` manager with its local
path `/` (`cli/index.ts:443-479`, `lib/mount.ts:7-17`). The manager then renders
the Stager dashboard, which lists jobs, or accepts its clone POST
(`addons/stager/app/index.ts:96-117`, `197-212`).

| Capability | Source evidence | Effect if the session is accepted |
| --- | --- | --- |
| Global Stager site listing | `/api/sites` returns `stagerService.listSites()` (`addons/stager/app/index.ts:185-187`); the wrapper queries every clonable panel site (`addons/stager/wrapper/clp-action-stager:2414-2442`) | Read site domains, types, users, applications, PHP versions, and database counts across the panel. |
| Global job and log access | The job page and API accept a syntactically valid job ID and return the wrapper's result/log (`addons/stager/app/index.ts:157-195`); the wrapper enumerates all job directories and emits each result (`addons/stager/wrapper/clp-action-stager:2613-2663`, `2666-2684`) | Read every retained Stager job, rather than only jobs created by that browser user. No per-user ownership check is present in these routes. |
| Completed staging credentials | Job results include staging database credentials and, for reverse-proxy clones, the new Instatic owner credentials (`addons/stager/wrapper/clp-action-stager:1017-1046`); the view renders database credentials (`addons/stager/app/views.ts:347-358`) and the Instatic secret (`addons/stager/app/views.ts:398-413`) | Expose credentials retained in completed job records, including jobs initiated by other users. |
| Clone PHP and static sites | The wrapper allowlists `php`, `static`, and `reverse-proxy` types (`addons/stager/wrapper/clp-action-stager:68-77`); PHP and static paths call `clpctl site:add:*` with generated site users and passwords (`addons/stager/wrapper/clp-action-stager:726-749`) | Create a new CloudPanel site, site user, document root, and copied files for an eligible source. |
| Clone an Instatic-backed reverse proxy | Reverse-proxy clones require a managed Instatic backend and source credentials (`addons/stager/app/index.ts:251-265`, `addons/stager/wrapper/clp-action-stager:635-676`); the clone path calls the Instatic root wrapper (`addons/stager/wrapper/clp-action-stager:750-780`) | Create a new Instatic instance/container and reverse-proxy site, then export/import the source bundle. |
| Copy databases | When the source has a database, the wrapper exports it, creates a staging database/user/password, and imports it (`addons/stager/wrapper/clp-action-stager:844-878`) | Duplicate eligible site data into a new database and expose its generated credentials in the job result. |
| Write vhosts and request certificates | The clone carries vhost state through a guarded panel/file path (`addons/stager/wrapper/clp-action-stager:803-839`); `--tls yes` invokes CloudPanel's Let's Encrypt command (`addons/stager/wrapper/clp-action-stager:993-1001`) | Write the clone's nginx configuration and request a certificate for the clone hostname. |
| Filesystem changes | Non-reverse-proxy clones copy the source document root and change ownership (`addons/stager/wrapper/clp-action-stager:880-899`) | Copy and chown site files as part of a clone. |

The Stager route itself has no delete verb; its exposed routes are reads and the
single clone POST (`addons/stager/app/index.ts:185-212`). That fact does not
bound the whole Addons UI to Stager. The enabled Instatic manager exposes
create, lifecycle start/stop/restart/recreate, snapshot, delete, and per-instance
update POSTs (`addons/instatic/app/index.ts:84-149`).

The wrappers are a bounded root boundary rather than proof of an arbitrary root
shell. The Stager wrapper accepts only its enumerated verbs and validates their
fixed arguments before dispatch (`addons/stager/wrapper/clp-action-stager:2736-2827`),
and the manager invokes it by a fixed absolute path, using `sudo -n` only when
the manager is not root (`addons/stager/app/service.ts:116-168`). Runtime
effects of the listed actions were not exercised in Wave 1. **Unverified:**
which of the source-level operations would complete in a particular installed
panel state; the authorization defect exists independently of that availability.

## 2. Authorization design

### Preferred design when trusted role data is available

Treat role extraction and authorization as one compatibility change. The
following is a proposal; its implementation is **Unverified**.

1. Extend the typed principal returned by `parsePanelSession` to carry a
   canonical, immutable role set, and propagate it through
   `authenticateRequest` into the manager's `auth` value. Keep the existing
   username, expiry, file provenance, token class, firewall, and MFA checks
   unchanged (`lib/sso-auth.ts:61-99`, `286-300`, `319-348`, `354-365`). Do not
   treat a missing MFA field as true; the current tests correctly reject that
   case (`tools/test-phase1.ts:123-135`).
2. Pin the parser to the authentic package schema before accepting roles. The
   reconstructed fixture places the role-name array at token-state index `4`
   (`tools/fixtures/session/authenticated.txt:11`), while the disposable
   decoded object exposed `AbstractToken.roleNames` and User role fields
   (**Observed in disposable container (R3)**). Those observations provide a
   conditional target, not a wire-format guarantee. The final parser should
   extract the token's granted-role collection at a verified structural
   location, requiring the exact expected node type, unique entry, bounded
   array, and canonical role-string grammar. It should reject an absent,
   duplicate, malformed, or schema-ambiguous collection.
3. Use an exact allowlist match for `ROLE_ADMIN`. Do not authorize on a
   substring, an unvalidated suffix, a User field merely because it is named
   `role`, or a role string supplied by the HTTP request. The token's granted
   role collection, after the authentic schema is pinned, is the source of
   authorization truth. Decoded User `role`/`roles` fields can be compared for
   diagnostics or compatibility testing, but must not silently override the
   token collection. **Unverified:** whether this exact canonical collection
   is stable across all supported CloudPanel package versions.
4. Add one central authorization gate in `cmdServe` after the health exception
   and successful authentication, before update lookup, `/` index rendering,
   mount dispatch, or any manager route (`cli/index.ts:459-480`). Return `403`
   for a valid authenticated session lacking `ROLE_ADMIN`; retain the existing
   login redirect for an invalid or unauthenticated session
   (`lib/sso-auth.ts:25-33`, `354-366`). Apply the same gate to both read and
   mutating Addons routes. Keep CSRF as a separate requirement for mutations
   (`lib/app-http.ts:34-67`).
5. Hide the injected header entry using the same panel permission once the
   native Twig context and permission name have been verified. This is a user
   interface improvement only; the server gate remains authoritative. The
   required native Twig context and permission expression are **Unverified**.
6. Do not equate panel ownership with authorization. The disposable run
   observed a synthetic owner with `ROLE_ADMIN` and a non-owner with
   `ROLE_SITE_MANAGER`, with different decoded role values (**Observed in
   disposable container (R3)**). If CloudPanel permits another non-owner admin,
   exact `ROLE_ADMIN` should authorize that user; `ROLE_SITE_MANAGER` should
   not.
7. Decide how demotion revokes already-issued sessions. The current parser
   trusts the serialized session until its expiry (`lib/sso-auth.ts:331-348`).
   **Proposal:** use CloudPanel's supported invalidation mechanism if one is
   available, or add a short-lived/revalidated authorization assertion for
   high-impact mutations. A role change must not wait silently for a long-lived
   token if the panel promises immediate revocation. **Unverified:** the
   deployed panel's session invalidation and role-change semantics.

   **Wrong if:** the supported panel contract guarantees that every role change
   immediately invalidates all affected session files before any manager
   request can be served; then an additional manager-side revalidation would be
   redundant.

The other authorization choices have these specific reversal conditions:

| Recommendation | Wrong if |
| --- | --- |
| 1–2: extend the principal and parse a pinned token schema | A supported authenticated panel bridge supplies a stronger, stable permission decision; validate that decision instead of adding another token parser. |
| 3: authorize on the exact token grant `ROLE_ADMIN` | The supported panel contract identifies a different authoritative permission or applies role hierarchy that an exact token-role match cannot represent. Use that verified contract, never a guessed substring. |
| 4: protect all Addons reads and writes centrally | The product requires non-admin use and every route/data source has a reviewed site-ownership policy; then introduce explicit capabilities and per-resource checks before allowing those users. |
| 5: hide the entry for unauthorized users | The product deliberately wants a visible access-request page; retain the server denial while changing the navigation presentation. |
| 6: permit any administrator, regardless of ownership | The requested root capabilities are deliberately owner-only; then a verified stable owner identity is required in addition to an administrator role. |

The source-level recommendation is to fail closed while role compatibility is
unknown. A parser that cannot prove both MFA completion and an exact
administrator role should produce no privileged principal. **Wrong if:** a
verified native CloudPanel permission check is guaranteed to run on every
request and independently authorizes every Addons route, including direct API
requests; in that case a duplicate role parser would add compatibility risk
without adding protection. No such guarantee is established here.

### If roles cannot be made dependable

There are four alternatives, each with a cost:

| Alternative | Trade-off |
| --- | --- |
| A panel-provided authorization bridge or signed assertion | Best alignment with CloudPanel's own policy and role changes, but couples the daemon to a panel endpoint/format and requires a carefully authenticated local bridge. A signed assertion needs key rotation, expiry, audience, and replay handling. **Unverified:** whether CloudPanel exposes such a bridge. |
| A separately reviewed root helper that looks up the username in a trusted panel authorization source | Keeps role parsing out of the daemon, but couples the helper to the panel DB/schema or a root-maintained API and introduces lookup availability and TOCTOU concerns. It must not trust a username/requester field supplied only by the daemon. **Unverified:** a stable supported role table/API for this package. |
| Root-maintained allowlist, or disabled Addons UI | A root-owned allowlist of authenticated stable panel identities avoids role parsing, but adds manual grant/revocation work and must address renamed or reused usernames. An owner-only policy needs a verified owner mapping; the current username-only principal does not provide one (`lib/sso-auth.ts:314-365`). Without that mapping or another trusted grant source, deny access. |
| Separate administrator login | Avoids the panel's serialization contract but adds a second credential, MFA, session, recovery, and revocation lifecycle and loses seamless panel SSO. **Unverified:** no such replacement auth system is established by the current gate (`lib/sso-auth.ts:354-365`). |

In all three cases, an unknown or malformed authorization result must fail
closed. **Wrong if:** CloudPanel documents and tests a stable, signed,
per-request capability that the daemon can verify without guessing at session
internals; then that capability should replace these fallback mechanisms.

### Fixtures required for offline tests

No fixture is changed in this task. The current tests assert acceptance of the
reconstructed authenticated fixture and rejection of its pending-MFA twin
(`tools/test-phase1.ts:84-96`), but they do not prove live role compatibility.
The fixture set needed before implementing the proposal is:

* sanitized, byte-accurate sessions for an owner/admin, a non-owner admin if
  CloudPanel supports one, a site manager/non-admin, and any ordinary panel
  user type;
* MFA off, pending MFA, and completed MFA variants for each relevant user;
* role changes and demotion/revocation cases, including an old session after a
  role change;
* missing, duplicate, unknown, malformed, overlong, and conflicting role
  collections, including disagreement between token granted roles and User
  entity fields;
* a raw-layout fixture captured from the actual supported package version with
  serialization structure and property ordering preserved while usernames,
  passwords, MFA seeds, cookies, keys, and other secrets are replaced inside
  the disposable environment before export. Recompute all affected UTF-8 byte
  lengths, including nested serialized strings, and record package/version,
  role, MFA state, capture method, and redactions. Never export raw secrets.

The parser tests must assert that exact role names authorize, similar strings do
not, and absent/ambiguous role data denies. They must also continue to assert
the existing file ownership, class, firewall, expiry, and MFA checks
(`lib/sso-auth.ts:61-99`, `286-348`). **Unverified:** the authentic raw layout
and whether all supported CloudPanel versions use one common role collection.

**Wrong if:** CloudPanel publishes a stable role-bearing fixture and a
supported parser contract for every deployed version; then additional live
capture work can be reduced to checking that contract and keeping one sanitized
regression fixture per version.

## 3. Listing bundled but non-enabled addons

The page currently receives only the config-enabled manager names and renders a
bare list of raw names (`cli/index.ts:450-453`, `496-504`). The registry already
contains optional `title` and `description` fields for both addons
(`cli/paths.ts:50-60`, `63-84`). The enabled predicate is already computable
without new state: `installedAddonSpecs()` and `installedConfig()` use
`existsSync(spec.configFile)` (`cli/provision.ts:72-74`, `398-400`).
No current index path uses the registry metadata; `indexPage` interpolates only
the escaped addon name and mount path (`cli/index.ts:496-504`). The enabled
manager list is captured when `cmdServe` starts, before it creates the UNIX
socket (`cli/index.ts:450-458`).

### Proposed catalog behavior

Build the index catalog from all `ADDONS`, in stable registry order. For every
spec:

* set `enabled = existsSync(spec.configFile)`;
* display `spec.title ?? spec.name` and `spec.description ?? ""`;
* render an explicit `Enabled` or `Available` status;
* make the manager link actionable only for an enabled addon, and give an
  available addon a privileged `Enable` action or a clear pending state after
  authorization;
* escape the title, description, name, and URL using the existing HTML escape
  helper (`lib/app-http.ts:69-72`; the current index already escapes names and
  mount paths at `cli/index.ts:496-504`).

This makes a newly bundled registry entry visible to an existing installation
even when its config file is absent. **Proposal:** enabled means “the managed
config marker exists,” not “the daemon is healthy, its wrapper is present, or
its injection is mounted.” The distinction follows the current predicates and
startup behavior (`cli/provision.ts:72-74`, `cli/index.ts:450-453`).

**Wrong if:** the product deliberately defines “available” as hidden until
installation, or the registry stops being the authoritative bundled-addon list.
That would contradict the stated design intent and should be recorded as an
explicit product decision before changing this recommendation.

The rollout must handle the zero-enabled case deliberately. `cmdServe` exits
when no addon is installed and also when no installed addon has a manager in
the binary (`cli/index.ts:450-453`), so a catalog that promises to show all
available addons cannot depend on a daemon mode that currently refuses to start
with zero enabled addons. **Proposal:** either keep a minimal catalog-capable
manager process available by an explicit design, or make the first installation
of the manager a separately guaranteed bootstrap step. Do not silently infer
that an available catalog can be served when the current daemon has already
exited.

**Wrong if:** the daemon is changed or replaced by a separately deployed
catalog service that is guaranteed to remain available with zero enabled
addons; then that service, rather than a new daemon mode, should serve this
catalog.

### Enablement and the root boundary

Enablement is privileged. The current daemon is a non-root systemd service and
uses fixed wrapper paths, with `sudo` only for those helper scripts
(`cli/provision.ts:402-432`, `addons/stager/app/service.ts:116-168`). The
sudoers rule does not grant the root CLI commands needed for install/configure
or repair (`cli/provision.ts:72-87`, `cli/index.ts:195-198`, `241-243`,
`283-285`, `381-384`). Widening it to the main CLI would grant a much broader
root interface than a user needs to enable one named addon.

**Recommendation:** if enablement is required in this UI, record a narrow,
typed desired-state intent and have a root-run, independently validated
consumer reconcile it. This is a proposal, not an existing capability. The
request schema should contain only an allowlisted addon identifier, a
fixed `enable` operation, a request ID, creation/expiry data, and an audit
principal plus a protected authorization reference for root-side validation.
That reference must identify a trusted session or scoped assertion, not merely
a username; keep it out of public status/logs and expire it after processing.
It must contain no shell text, executable path, arbitrary config
body, URL, release flag, or attestation bypass. The consumer should enforce:

* a dedicated handoff directory with regular-file, owner, mode, no-symlink,
  atomic-write, and bounded-size checks;
* exact addon and operation allowlists, current registry membership, and
  revalidation against current panel/system state at execution time;
* durable request and result state, idempotency by request ID and desired
  state, and safe handling of duplicate requests or a daemon restart;
* root-owned configuration and wrapper installation, with no permission for
  the daemon to forge root-owned status or to choose a command, path, URL, or
  release artifact;
* an authorization trust boundary that does not treat a free-form `requester`
  field as proof. The daemon may record the authenticated principal for audit,
  but the root consumer must independently validate the capability/session or
  accept only a narrowly scoped, expiring assertion from a verified bridge.
  If no independent validation is possible, the root consumer must be limited
  to a policy that is safe for any request the daemon can submit, or the action
  must remain unavailable.

Revalidate the originating administrator grant when execution begins. If the
session has expired or the user was demoted while queued, report that renewed
authorization is required. This is distinct from the unrelated live-session
probe that currently prevents ordinary background repair. **Wrong if:** the
product explicitly grants a durable, scoped approval that survives logout;
then validate that approval and its revocation rules instead of requiring the
original session to remain live.

The existing timer and path units are precedent for root convergence, but they
do not consume such an intent today. The timer runs full `repair --quiet`
every 15 minutes (`cli/provision.ts:439-458`), while the template path watcher
invokes only `repair --anchors-only --quiet` (`cli/provision.ts:460-477`). A
new intent needs a dedicated root service trigger plus the timer as a recovery
fallback; merely writing a file does nothing in the current implementation.

The current full-repair path also has an explicit open defect. `cmdRepair`
calls `ensureDirs(all, true)` before continuing (`cli/index.ts:291-307`), and
`ensureDirs(..., true)` calls `ensurePanelSessionReadable`, which requires a
regular `clp`-owned session file (`cli/provision.ts:288-320`, `259-286`). If no
panel session file exists, full repair aborts. The anchors-only path returns
before that check (`cli/index.ts:283-289`). Any intent consumer that relies on
full repair must fix or separately handle this no-session prerequisite first;
the catalog proposal must not claim that the existing timer already enables
addons.

The existing repair writer is likewise not a desired-state enablement system:
it enumerates the currently installed configs and rewrites those configs
(`cli/index.ts:294-300`); it has no input for an Addons-page intent. **Unverified:**
any future branch or deployment wrapper that might add such an input outside
this checkout.

This recommendation must also avoid using config creation as an unreviewed marker
of UI intent. **Proposal:** the root consumer should create the
managed config only after validating the request and completing the required
artifact/wrapper/provisioning steps, then restart/reconcile and write status.
The daemon should not create a root-owned config file merely because a browser
clicked a button. **Unverified:** the final ownership/mode and handoff layout
for a future intent directory; the current state directory is provisioned as
root-owned with a shared group (`cli/provision.ts:303-312`).

**Wrong if:** a reviewed narrow sudo rule can invoke a fixed enable
helper whose argument contract and root-side authorization are demonstrably no
broader than the typed worker, and the helper has better crash/idempotency
semantics than the proposed reconciler. In that case a direct helper may be
simpler. The current exact-wrapper rule does not establish that helper today.
An exact sudo rule for such a helper could provide lower latency and avoid a
queue, but synchronous execution alone would not solve restart recovery or
duplicate requests. Broad access to the main CLI is unnecessary under either
proposal. These are design trade-offs; both implementations are **Unverified**.

## 4. Whole-binary update button

The existing update notice is already supplied from `checkCliUpdate` on each
authenticated manager request (`cli/index.ts:465-474`) and rendered as a notice
that says `clp-addons update` (`lib/app-ui.ts:137-162`). The current command
requires root (`cli/index.ts:241-243`), and the current sudoers rule grants only
the exact addon wrappers (`cli/provision.ts:72-87`). A browser cannot invoke
the current root update path through the existing authorization boundary.

The update discussed here is the clp-addons product update. The manager imports
both addon handlers into one CLI binary (`cli/index.ts:20-37`), and installation
writes the main binary plus the enabled wrapper artifacts
(`cli/index.ts:118-123`). It is therefore a whole-product/binary update. This
must stay distinct from the Instatic instance `update` route, which updates one
container instance through `addons/instatic/app/index.ts:119-149`.

### Recommendation and privilege model

After central authorization exists, add an explicit update button on the
Addons page for `ROLE_ADMIN` only. Keep the release notice as a notice until an
administrator explicitly requests the update; do not let the button itself
become an authorization mechanism. The button
should submit a fixed update intent to the privileged worker described below,
and the worker should return a durable operation ID for status polling.

Automatic unattended update remains rejected by the task's design decision:
the product executes privileged helpers, and an unattended pull would give the
release pipeline unattended root authority on every installation. The notice stays a
notice until an administrator explicitly requests the update. This is a task
design decision, not a claim about an external release process.

The current daemon is explicitly non-root (`User=clp-addons`, with bounded
write paths in its systemd unit) and uses `sudo` to invoke only the named
wrappers (`cli/provision.ts:414-432`, `addons/stager/app/service.ts:124-128`).
Do not change that model by running the browser-facing manager as root. Use a
separate, fixed root update worker or a narrowly reviewed root helper.
**Wrong if:** the product deliberately adopts unattended updates backed by a
separately approved release-trust policy. That would reverse the task's explicit
decision and is outside this proposal; it does not justify changing the notice
into an automatic action now.

### Update transaction requirements

The current command dispatch treats `self-update` as deprecated and directs
operators to `update` (`cli/index.ts:539-550`). The design should follow the
current `cmdUpdate` source and its verification/restart path, rather than the
older `reexec --no-self-update` description in `docs/DECISIONS.md:362-376`.
**Unverified:** any deployment-specific re-exec behavior outside this checkout.

The worker should:

1. Accept only the exact release tag shown to and requested by the administrator,
   selected from trusted release metadata. Resolving `latest` may populate that
   preview, but execution must not silently advance to a newer release after
   approval. Reuse the existing tag
   validation, SHA256 verification, and attestation verification
   (`cli/release.ts:45-60`, `81-99`, `110-145`). The UI must not provide an
   arbitrary download URL, `--skip-attestation`, shell flag, or artifact path;
   the current CLI's skip flag exists at `cli/index.ts:244-257` but is not a
   safe browser capability.
2. Take one global update lock before resolving or installing artifacts. Coalesce
   duplicate clicks and concurrent sessions onto the same operation and target
   version. A retry of an already successful target should return the existing
   result or a verified up-to-date result; it must not start interleaved
   provisioning. **Unverified:** the current command has no demonstrated
   request-level update lock or browser idempotency contract. Its artifact
   manifest can recognize matching installed artifacts
   (`cli/index.ts:83-109`), but that is not proof against two simultaneous
   update processes (`cli/index.ts:241-280`).
3. Persist `pending`, `running`, `succeeded`, and `failed` states with request
   ID, target/current version, safe error text, timestamps, and a bounded log or
   diagnostic reference. On a manager restart, the page should reconnect to
   the operation ID and report the persisted result. Secrets and arbitrary
   release responses must not be copied into browser-visible status.
4. Verify the complete artifact set for the installed addon set, install
   wrapper assets and the main binary, reconcile units, and confirm the new
   manager is serving the expected version and `/health` response. When the
   current implementation has artifacts to install, it writes each wrapper and
   the binary using separate atomic replacements and updates its artifact manifest
   (`cli/index.ts:118-123`; `cli/util.ts:74-88`), then
   reinstalls/restarts units and reconciles anchors/proxy
   (`cli/index.ts:260-280`). A future worker must preserve those checks while
   recording each phase.
5. Treat binary replacement as self-replacement of a running service. The
   current writer creates a temporary file and renames it into place
   (`cli/util.ts:78-84`); the current update path then restarts the manager
   systemd unit (`cli/index.ts:274-280`; `cli/provision.ts:495-503`). The
   atomic rename changes what future executions find, while a process already
   running needs a controlled restart to execute the new image. **Proposal:**
   have a separate fixed updater in its own systemd unit, outside the manager's
   service lifetime, own the transaction, stop/restart the manager
   at a defined point, and verify startup/version/health afterward. Do not rely
   on the browser request surviving its own daemon restart.
   Stage the complete verified candidate set before activation. If a release
   changes provisioning or artifact rules, hand off once to a fixed entrypoint
   in the verified candidate binary under the same operation ID and lock, so
   the new version runs its own reconciliation. Bound that handoff to avoid a
   re-exec loop; do not pass arbitrary browser flags. **Unverified:** the
   versioned updater entrypoint and handoff contract do not exist as proposed
   in this checkout (`cli/index.ts:241-280`, `539-550`).
6. Make activation and update mutually non-interleaving. If a request changes
   the enabled addon set, the worker must resolve that target set first and
   install the matching binary/wrappers under the same global lock. A failed
   update must leave the prior verified artifact set or a recoverable pending
   state; a crash between binary, wrapper, manifest, and unit writes must be
   detected and repaired by root-owned startup/reconciliation logic. The exact
   rollback and crash-recovery algorithm is **Unverified** and must be designed
   before implementation.

The transaction choices have these reversal conditions:

| Requirement | Wrong if |
| --- | --- |
| 1: pin the administrator-approved release and verify its assets | The approved product policy deliberately authorizes a floating target, or a platform verifier provides an equivalent immutable trusted artifact identity; adopt that explicit contract. |
| 2 and 6: one lock across updates and enablement, with idempotency | A verified transactional activation system already serializes every writer and safely retries operations; use its transaction identity instead of another lock. |
| 3: persist operation status and reconnect | A platform operation service already persists equivalent authenticated status independently of the manager; reuse it. |
| 4–5: staged artifacts, controlled restart, candidate handoff, version/health confirmation | A supervisor or package manager already owns verified activation and new-version migrations; delegate those phases to it. A handoff is unnecessary when provisioning compatibility is explicitly guaranteed. |

The UI result should distinguish “accepted,” “running,” “restarted and
verified,” and “failed with recovery needed.” A double click should point to
one operation, and a browser reconnect after restart should not make a
successful update look like a timeout. **Wrong if:** a platform-provided root
update service already supplies exact artifact verification, global locking,
atomic activation, crash recovery, and durable status with a stable API. In
that case the Addons button should submit to that service rather than creating
another updater. **Unverified:** no such service is established in the
checked-in repository.

### Update-specific privilege conclusion

The button is appropriate only after the same `ROLE_ADMIN` decision protects
the page and server route. `cmdUpdate` is a root operation, and the current
daemon's bounded wrapper sudoers rule does not authorize it
(`cli/index.ts:241-243`, `cli/provision.ts:72-87`). Granting the daemon a
wildcard or the full main binary would widen the root boundary to install,
repair, uninstall, and arbitrary CLI flags. **Recommendation:** a fixed root
worker with an allowlisted update intent, exact release resolution, and
durable status is the narrowest shape justified by the requested button.
**Wrong if:** the product decides that no in-panel update may ever be
requested, in which case the existing notice should remain command text and no
button should be added.

## 5. Sequencing

The work should proceed in this order:

1. **Reconcile the implementation baseline.** Confirm all design documents and
   tests use the actual per-addon header targets and exact wrapper sudoers
   paths (`lib/panel-nav.ts:70-94`, `addons/instatic/inject/targets.ts:11-12`,
   `addons/stager/inject/targets.ts:33-34`, `cli/provision.ts:72-87`). This
   prevents an authorization design from targeting a nonexistent generic nav
   route or an imagined `action *` command. **Wrong if:** a later commit changes
   those interfaces before implementation; then this memo's cited baseline
   must be refreshed first.
2. **Close the disposable evidence gap.** In fresh disposable containers,
   exercise the unmodified repository path through real nginx and the actual
   session directory/cookie configuration using MFA-complete owner and
   non-owner sessions. Capture sanitized raw bytes and test header rendering.
   This is the only safe way to settle the yes/no real-panel question after R3's
   MFA-disabled result. **Wrong if:** an authoritative supported CloudPanel
   contract already proves the native route, session layout, MFA completion,
   and role semantics; then a smaller compatibility fixture run may suffice.
3. **Implement and test authentication compatibility together with
   authorization.** Pin the authentic role schema, extend the principal, add
   the central `ROLE_ADMIN` gate, align the nav condition, and add the fixture
   matrix before exposing any new catalog or update action. Fixing only the
   cookie/session compatibility would risk making non-admin requests pass an
   unauthorised daemon. The central route location and current auth ordering are
   visible at `cli/index.ts:459-480`; existing MFA and provenance checks are at
   `lib/sso-auth.ts:61-99`, `331-366`. **Wrong if:** the panel itself supplies a
   verified per-request permission assertion that the daemon enforces before
   every route; then duplicate role extraction should be replaced by validation
   of that assertion.
4. **Resolve the no-session repair prerequisite and design the privileged
   worker/intent/status boundary.** Full repair currently requires a live
   `clp`-owned session (`cli/index.ts:291-307`, `cli/provision.ts:259-320`),
   while the existing path watcher is anchors-only
   (`cli/provision.ts:460-477`). The root consumer must be specified,
   independently validated, idempotent, and observable before a browser can
   request enablement. **Wrong if:** full repair is changed or proven safe to
   run without a session before this step; the intent design still needs its
   own narrow trust boundary and status protocol.
5. **Add the catalog and enablement flow.** Once authorization and root
   convergence are proven, render all registry entries from `ADDONS`, use
   `existsSync(configFile)` for enabled/available state, escape metadata, and
   handle zero-enabled startup intentionally (`cli/paths.ts:63-84`,
   `cli/provision.ts:72-74`, `cli/index.ts:450-504`). **Wrong if:** the release
   policy intentionally hides bundled entries until installation; that would
   contradict the stated design intent and should be recorded as a deliberate
   product change.
6. **Add the explicit whole-binary update last.** Reuse verified release
   artifacts, route through the fixed root worker, coordinate with enablement,
   restart and health-check the daemon, and persist results. This ordering keeps
   a new root-capable button behind both authentication evidence and a tested
   transaction boundary. **Wrong if:** a pre-existing platform update service
   already owns this exact verified/idempotent transaction; integrate with it
   instead of implementing a second worker.

The resulting release gate is straightforward: do not release the expanded UI
while an accepted session still carries only a username and no central role
decision (`lib/sso-auth.ts:314-365`), and do not claim the end-to-end non-owner
answer until the MFA-complete disposable experiment is complete. This memo
contains no implementation of that gate.

## Investigation scope and retained artifacts

**Observed in the disposable-container investigation (R3 runtime/cleanup
report):** CloudPanel ran in the newly provisioned container
`clp-authz-r3-systemd`; that container and its temporary
`clp-authz-r3-image:local` image were removed after the experiment. The agent
also built `/tmp/clp-addons-r3-20260911-linux-x64` on the host, copied it into
the container, and deleted the host binary afterward. Thus the investigation
used transient artifacts outside the memo; it did not meet a literal reading
of “no files modified outside the memo” during provisioning. No production
CloudPanel was inspected. Only this document is retained as a repository change.

**Unverified:** the native header audience, real raw token layout, MFA-complete
SSO compatibility, and end-to-end non-admin Addons access remain open. CloudPanel
did boot; these gaps are incomplete experiments, not a claimed boot failure.
The memo's proposed controls have not been implemented or runtime-tested.
