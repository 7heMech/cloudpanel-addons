# Redirects

## Scope

Redirects forwards a source domain (and its `www` when the source is a zone apex)
or a single subdomain host to another URL with a 301, 302, 307, or 308 status,
optional path preservation, and optional query string preservation.

Redirects manages HTTP forwarding only. It never manages mail records (`MX`,
`SPF`, `DKIM`, `DMARC`), verification `TXT` records, `SRV`, or `CAA` records,
and it does not import from `addons/dns`. Operators manage non-web DNS records
independently in DNS or directly at their DNS provider.

## Cloudflare Single Redirects and placeholders

Redirects reads the shared Cloudflare connections from `/var/lib/clp-addons/cloudflare/`
(`lib/cloudflare/store.ts`). When a redirect has `mode: "auto"` and a connected
Cloudflare zone matches its source host, Redirects manages two things in that
zone:

1. One Single Redirect rule in the zone's `http_request_dynamic_redirect`
   entrypoint with `ref` set to `clp_redirect_` followed by a 16-hex SHA-256
   prefix of the source host. Redirects also recognizes legacy
   `clp_dns_redirect_` refs from earlier DNS releases in place with zero rule
   churn. With keep path on, the target uses
   `concat("<target>", http.request.uri.path)`, so a target that keeps the path
   cannot contain a query string and drops a trailing slash. With keep path off,
   the target is a static URL.
2. Proxied `AAAA 100::` placeholder records at each host the redirect answers
   for (`source` and `www.<source>` when `source` is the zone apex, or `source`
   alone for a subdomain).

The placeholder diff inspects and changes only `A`, `AAAA`, and `CNAME` records
at those exact redirect hosts. It leaves `MX`, `TXT`, `SRV`, `CAA`, and every
other hostname in the zone untouched. A below-apex `NS` delegation at a redirect
host blocks placeholder writes rather than overwriting delegated names.

Redirects writes or updates the Single Redirect rule before writing placeholder
records so a placeholder never answers without its rule.

When more than one connection reaches the same zone and no zone choice names
one, Redirects uses a connection whose token is known to grant both `DNS: Edit`
and `Single Redirect: Edit` there, then one not known to lack either.

External rules (such as rules left by Terraform or OpenTofu) are taken over in
place when exactly one rule quotes the redirect's whole hosts (`http.host eq`,
`==`, or `in`, optionally excluding `/.well-known/acme-challenge/`). If
Cloudflare refuses a `ref` change on update, Redirects retries with the rule's
existing `ref` and continues matching it by host expression. Two matching rules
or a non-whole-host rule block the redirect as a plan problem instead of adding
a duplicate rule beside it.

**Find in Cloudflare** scans reachable Cloudflare zones'
`http_request_dynamic_redirect` entrypoints for whole-host redirect rules not
yet managed by Redirects or backed by a CloudPanel site, and imports selected
rules in one review.

## Local stand-in sites

When no Cloudflare connection exists, when no connected Cloudflare zone matches
the redirect's source host, or when the operator sets `mode: "local"`, Redirects
serves the redirect from this server with a CloudPanel static site whose Nginx
vhost returns the configured status and target URL and serves
`/.well-known/acme-challenge/` from the site's root. If any Cloudflare
connection fails discovery, every `auto` redirect fails closed, even one that
another connection's zone matches, because the failed connection could hold a
longer matching zone. It neither writes to Cloudflare nor falls back to a
stand-in site.

Stand-in vhosts are written to both CloudPanel's SQLite database and Nginx
through `lib/site-vhost.ts` so CloudPanel keeps the redirect rules when it
rewrites the vhost after installing a certificate.

`standins.json` under `/var/lib/clp-addons/redirects/` records each stand-in
with a generated `siteUser` ending in eight random hex digits before `clpctl
site:add:static` runs, then records CloudPanel's `siteId` once creation finishes.
`lib/stand-ins.ts` provides `isStandInSite`, `ownsStandInSite`, and
`standInDomains` (merging `/var/lib/clp-addons/redirects/standins.json` and any
pre-migration `/var/lib/clp-addons/dns/standins.json`) so DNS, Firewall, Stager,
Maintenance, SMTP Relay, Git, and Terminal omit stand-ins from ordinary site
lists, while Panel Tweaks labels them "Redirect" on CloudPanel's Sites page.

Redirects mutates or deletes a site only when `ownsStandInSite` confirms both
`siteUser` and `siteId` match. A real CloudPanel site created later at the same
domain never matches, so Redirects never overwrites or deletes it. If stand-in
creation fails after CloudPanel creates the site and cleanup deletion also
fails, Redirects keeps the ownership record marked `incomplete: true` so a later
pass completes the vhost or deletes the site safely.

On every `reconcile` pass, `retryStandInCertificates` checks whether each
stand-in's installed certificate covers all effective hosts (`issuedForAll` from
`lib/panel-custom-domain.ts`, checking both the apex and `www` when present)
before marking the certificate job done. Failed attempts retry after 15 minutes,
1 hour, 6 hours, and then daily.

## Ask first, Automatic, and provider transitions

Redirects starts in Ask first mode. Until the operator connects Cloudflare or
adds a redirect, the page renders a focused first-run card without absent
Cloudflare controls. Once configured, the page uses `.section-shell` with
Redirects, Settings, and Activity sections, and cuts tables longer than ten rows
on phones behind a Show all button (`tbody[data-phone-cut="redir-list"]`).

In Automatic mode, any change that alters what Redirects writes (turning on
Automatic, saving or taking over redirects, choosing a zone, releasing a held
transition, deleting a Cloudflare rule, or replacing a redirect from Create
Site) builds a live plan, stores a root-only pending review with a random token
and plan digest for 15 minutes, and applies changes only when confirmation
matches the live re-plan.

Provider transitions never happen silently. Adding a Cloudflare connection (from
Redirects or through the shared store in DNS, Firewall, or Manager), removing a
Cloudflare connection, or discovering a newly matching Cloudflare zone for an
existing stand-in places affected redirects in `policy.held`. Held redirects
wait through scheduled checks until an administrator reviews and confirms the
move through `review-redirect`. Once a Cloudflare rule and placeholder are in
place on an active zone, Redirects deletes the retired stand-in site.

Deleting a redirect or replacing it checks connected Cloudflare zones for an
existing rule even when the redirect is currently `mode: "local"` or served by a
stand-in. If any Cloudflare connection fails discovery, or a zone cannot be read
or has conflicting rules, deletion blocks rather than orphaning a Cloudflare
rule. On confirmation, Redirects deletes the
Cloudflare rule and any stand-in site while leaving non-web DNS records
untouched.

## Replacing a redirect on Create Site

Creating a CloudPanel site at a domain that already redirects never silently
deletes the redirect, its Cloudflare rule, or its stand-in site. If an
administrator creates the site directly, Redirects surfaces a conflict problem
on that redirect instead of removing anything automatically.

To make site replacement explicit, Redirects injects a helper block
(`addons/redirects/inject/create-site.ts`, `required: false`) before
`ANCHORS.newSiteButtons` across all six native CloudPanel Create Site templates
(`wordpress`, `php`, `static`, `nodejs`, `python`, `reverse-proxy`), wrapped in
`{% if is_granted('ROLE_ADMIN') %}`. The markup carries no `name` attributes so
Symfony never rejects undeclared fields, and its plain ES5 script attaches no
`submit` listener.

On load, the helper warms the CSRF cookie via `GET /addons/redirects/api/session`
and fetches `GET /addons/redirects/api/create-site-helper`. That endpoint reads
local policy and status files only and makes no Cloudflare API calls. When the
entered domain matches a redirect's source or covered hosts, the helper shows an
inline notice right below the Domain Name row with a **Replace redirect with
this site** button.

Clicking the button posts `POST /addons/redirects/api/redirects/prepare-replace`,
which plans removal against live Cloudflare and stand-in state, then opens a
`<dialog>` mounted on `document.body` listing the exact Cloudflare rule and
stand-in site deletions (and noting that non-web DNS records stay untouched).
Confirming posts `POST /addons/redirects/api/confirm`, verifies the plan digest,
removes the redirect, and replaces the warning with a green confirmation banner
so the administrator can click Create. The helper drops a review that arrives
after the Domain Name field moved to another redirect, and shows the banner
only for hosts covered by the redirect the server reports as `replaced`. It
builds every URL from the fixed `/addons/redirects` mount and does nothing when
its `data-url` differs.

## Permissions and access control

All fourteen web verbs in `addons/redirects/verbs.ts` require `web: "admin"`.
Non-administrators cannot view or modify redirects, trigger Create Site
replacement, or reach shared Cloudflare tokens. `reconcile` is root-only and
runs through `clp-addon-redirects-reconcile` queued by repair with a 30-minute
runtime bound.

In `lib/cloudflare/tokens.ts`, `Single Redirect: Edit` (`dynamic_redirect`)
belongs to `consumer: "redirects"`. Redirects' token template requires `DNS:
Edit` (for placeholder records), `Single Redirect: Edit`, `Zone: Read`, and
`API Tokens: Read`. The shared Connect Cloudflare dialog
(`lib/cloudflare/connect-dialog.ts`) lets operators select any combination of
DNS records, Redirect domains, and Panel gate. When Redirects is enabled with
active Cloudflare connections and auto-mode redirects under those zones (or
refused redirect permissions), `addons/redirects/setup.ts` reports missing
`DNS: Edit` or `Single Redirect: Edit` permissions under Setup's Action needed
band.

## Migration from DNS

Upgrading from a release where DNS owned redirect domains runs
`migrateRedirectsFromDns` (`addons/redirects/migration.ts`) under `dns.lock`,
`redirects.lock`, and `cloudflare.lock` directly after
`migrateCloudflareFromDns`. It validates every touched file with
`isTrustedFile`, moves `redirects`, `standins.json`, redirect holds, tracked
`redirectRules`, Cloudflare `zoneChoices`, and Cloudflare `connectionIds` into
`/var/lib/clp-addons/redirects/`, drops `profileId`, marks redirects that were
on PowerDNS as `mode: "local"` while keeping their custom stand-in `hosts`, and
cleans those fields from DNS. A redirect is on PowerDNS when its legacy plan
resolved a PowerDNS zone, or, with no resolved zone, when a PowerDNS zone
choice covers its source.

If DNS is enabled (`dns.conf` exists), migration enables Redirects and carries
over `automatic`. If DNS is disabled, Redirects stays disabled with `automatic:
false`. The function returns a rollback closure that restores every touched file
byte-for-byte and removes newly created Redirects state and config if the update
rolls back.
