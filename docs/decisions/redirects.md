# Redirects

## Scope

Redirects forwards a source domain (and its `www` when the source is a zone apex)
or a single subdomain host to another URL with a 301, 302, 307, or 308 status,
optional path preservation, and optional query string preservation.

A redirect's hosts are the ones it answers for where it resolves: its Cloudflare
zone's hosts, or its stand-in site's hosts (the registrable domain's `www` is
included). A plan blocks before any write when another redirect answers for one
of them, and the problem names both redirects. A real CloudPanel site at one of
them replaces the redirect (see [Sites replace redirects](#sites-replace-redirects)).
Hosts depend on the selected zone, so these checks run at planning, not when the
policy is parsed. Saving or taking over a redirect is refused outright when its
source, its `www` when the source is a registrable domain, or a custom stand-in
host is already a site, and a review blocks a new redirect whose planned hosts include one.

Redirects manages HTTP forwarding only and never handles mail. It never manages mail records (`MX`,
`SPF`, `DKIM`, `DMARC`), verification `TXT` records, `SRV`, or `CAA` records,
and it does not import from `addons/dns`. DNS reads Redirects' saved state
through `lib/redirect-domains.ts` to warn on the rows a redirect covers and to
leave out a stand-in served at the edge; a redirect domain's mail is a DNS-only
domain in DNS. See [DNS](dns.md#redirects-domains-and-stand-ins).

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
a duplicate rule beside it. So does any other enabled rule whose `wildcard`,
`matches`, `starts_with`, `ends_with`, or `contains` test on `http.host` or
`http.request.full_uri` could match one of the redirect's hosts. A `full_uri`
wildcard is tested whole against `http(s)://<host>/` and `http(s)://<host>:`
prefixes, since `*` spans slashes. A `full_uri` regex counts unless it starts
with `^`, a fixed `http`/`https` scheme and `://`, then literal host characters
that rule the host out. That problem also blocks deleting or replacing the
redirect, since removing only its own rule would leave the host redirecting.
Rules that test only the path or other fields are not counted.

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
Automatic, saving or taking over redirects, choosing a zone, or releasing a held
transition) builds a live plan, stores a root-only pending review with a random
token and plan digest for 15 minutes, and applies changes only when confirmation
matches the live re-plan. Deleting a redirect is reviewed the same way in both
modes (see below). In Ask first mode Redirects writes nothing else.

Provider transitions never happen silently. Adding a Cloudflare connection (from
Redirects or through the shared store in DNS, Firewall, or Manager), removing a
Cloudflare connection, discovering a newly matching Cloudflare zone for an
existing stand-in, or losing the Cloudflare zone of a redirect that has no
stand-in yet places affected redirects in `policy.held`. Redirects compares each
new plan with the last recorded one, so a read-only refresh that sees the change
first holds the redirect just as a scheduled check would. Held redirects
wait through scheduled checks until an administrator reviews and confirms the
move through `review-redirect`. Once a Cloudflare rule and placeholder are in
place on an active zone, Redirects deletes the retired stand-in site.

Deleting a redirect, whether Redirects is Automatic or asks first, always
removes its Cloudflare rule. The server always shows a review listing the rule
and any stand-in site it deletes, even with no Cloudflare connection, and
applies it only on confirmation of that plan's digest, which covers the rule
itself. The check covers connected Cloudflare zones even when the
redirect is currently `mode: "local"` or served by a stand-in. It reads the selected zone, the longest matching zones, and every zone
where it has seen the redirect's rule (`status.redirectRules`). A check adds
the selected zone once it finds the rule there, and drops a tracked zone only
when a read of that zone shows no rule left. If any
Cloudflare connection fails discovery, no connection lists a tracked zone,
a zone cannot be read, a zone has conflicting rules, or more than one zone holds
a rule for the redirect, deletion blocks rather than orphaning a Cloudflare
rule. On confirmation, Redirects deletes the Cloudflare rule first, then any
stand-in site, while leaving DNS records untouched; deleting a redirect a site
has replaced also deletes its placeholder records.

## Sites replace redirects

A real CloudPanel site (not the redirect's own stand-in, judged by
`ownsStandInSite` and `isStandInSite` in `lib/stand-ins.ts`) at a redirect's
source or at a host it answers for replaces the redirect. The plan for that
redirect carries `replacedBy` and lists the removal: the Cloudflare rule (looked
up as for deletion, in the selected, longest matching and tracked zones), the
proxied `AAAA 100::` placeholder records at its hosts in those zones, and its
owned stand-in site. No other record is touched, and the real site never is:
`StandIns.remove` deletes a site only when `ownsStandInSite` matches.

In Automatic mode the next run applies it without a review: the new-sites hook,
a scheduled check, or Check now. Redirects declares `newSites`, which runs
`sync-sites`; Redirects sits before DNS in catalog order so the redirect is gone
before DNS's hook plans the new site's records. `sync-sites` first checks,
without the lock or any Cloudflare call, whether a site uses a redirect's source,
its `www`, or a custom stand-in host, and returns at once when none does. The
rule is deleted first, then placeholders, then the stand-in. The redirect is then
dropped from the policy, its plan, tracked zones and hold, and each step is
logged "Replaced by the site <domain>".

In Ask first mode the removal waits as pending changes on the redirect, shown as
"Replaced by a site". Turning on Automatic reviews and applies it with
everything else, and deleting the redirect reviews and applies it alone. Either
review's digest covers the rule and placeholder records it deletes, so one
recreated in between shows a fresh review.

When the rule cannot be read (a connection failing discovery, an unreadable or
unreachable tracked zone, two matching rules, rules in two zones, or another
enabled rule matching the host by pattern), the plan carries that problem and
the redirect is kept whole. A failed delete is recorded as a problem and retried
on the next run.

## Create Site notice

Redirects injects an informational notice (`addons/redirects/inject/create-site.ts`,
`required: false`) before `ANCHORS.newSiteButtons` across all six native
CloudPanel Create Site templates (`wordpress`, `php`, `static`, `nodejs`,
`python`, `reverse-proxy`), wrapped in `{% if is_granted('ROLE_ADMIN') %}`. The
markup carries no `name` attributes so Symfony never rejects undeclared fields,
and its plain ES5 script attaches no `submit` listener and posts nothing.

On load it fetches `GET /addons/redirects/api/create-site-helper`, which reads
local policy and status files only and makes no Cloudflare API calls. When the
entered domain matches a redirect's source or the hosts it answers for in its
last plan (the hosts a site replaces it at), the notice below the
Domain Name row says that creating the site replaces the redirect, removing its
Cloudflare rule and any stand-in site (once reviewed in Redirects, when it asks
first). A stand-in site already holds its own source domain in CloudPanel, so for
that domain the notice says to delete the redirect in Redirects first. The script
builds every URL from the fixed `/addons/redirects` mount and does nothing when
its `data-url` differs.

## Permissions and access control

All thirteen web verbs in `addons/redirects/verbs.ts` require `web: "admin"`.
Non-administrators cannot view or modify redirects, see the Create Site notice,
or reach shared Cloudflare tokens. `reconcile` is root-only and runs through
`clp-addon-redirects-reconcile` queued by repair with a 30-minute runtime bound.
`sync-sites` is root-only and run by the new-sites watcher.

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
`redirects.lock`, and `cloudflare.lock` after
`migrateCloudflareFromDns` and Firewall's Cloudflare edge migration. It validates every touched file with
`isTrustedFile`, moves `redirects`, `standins.json`, redirect holds, tracked
`redirectRules`, Cloudflare `zoneChoices`, and Cloudflare `connectionIds` into
`/var/lib/clp-addons/redirects/`, hands each redirect's `profileId` with mail
rows to DNS as a DNS-only domain with that Mail role (through DNS's own `upgradeSavedPolicy`, passed in by
`cli/addons.ts` so Redirects never imports DNS), marks redirects that were
on PowerDNS as `mode: "local"` while keeping their custom stand-in `hosts`, and
cleans those fields from DNS. A redirect is on PowerDNS when its legacy plan
resolved a PowerDNS zone, or, with no resolved zone, when a PowerDNS zone
choice covers its source.

If DNS is enabled (`dns.conf` exists), migration enables Redirects and carries
over `automatic`. If DNS is disabled, Redirects stays disabled with `automatic:
false`. The function returns a rollback closure that restores every touched file
byte-for-byte and removes newly created Redirects state and config if the update
rolls back.
