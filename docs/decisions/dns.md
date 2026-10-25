# DNS

## Scope

DNS keeps each CloudPanel site's Cloudflare records to a profile, so that
creating a site is enough to publish it. Mailcow is an optional integration of a
profile: the site's domain, its DKIM key and a shared mailbox's permission to
send as it. The addon is meant to replace infrastructure-as-code for these
records rather than coexist with it: it follows the panel's site list, and what
it enforces cannot drift.

Nothing about one operator's setup is built in. The server's addresses are
detected, the Mailcow host, key policy and mailbox are settings, and the
records are rows anyone can edit.

## Profiles

A profile is an ordered list of record rows plus the zone options below, and a
mode. Sites are assigned in bulk, and one profile can be the default for new
sites, as in PHP Resources and SMTP Relay; choosing a default or assigning a site
records the site ids that exist then, so a default never reaches back over the
fleet.

A row has a type (A, AAAA, CNAME, MX, TXT, SRV, CAA), a name, content, proxy,
TTL, a priority for MX and SRV, and "apex only", which skips the row when the
site is not its zone's apex -- what `www` needs. Names and content take
`{domain}`, `{zone}`, `{sub}` and `{mailcow.selector}`; content also takes
`{ipv4}`, `{ipv6}`, `{mailcow.host}` and `{mailcow.dkim}`. A rendered name
must lie in the site's zone; `{zone}` is how a `www.example.com` site reaches
`example.com`. A row whose address placeholder is empty -- a server with no
IPv6 -- writes nothing but still owns its name, so a stale AAAA is removed. An
address that cannot be detected -- more than one of a family, or an IPv4 behind
NAT once CloudPanel's cached one has expired -- stops the sites that use it
until it is set under Server addresses. A save is checked by rendering every
row for an apex and a subdomain site. Duplicate records and multiple CNAME
rows at one name are refused before saving.

Presets only fill the editor: Web (CloudPanel), Mailcow, Google Workspace and
DMARC. A new install offers two profiles built from them, "Web" and "Web and
Mailcow", produced on read so a deleted one stays deleted. Both start in Report
only, as every new profile does.

## What a profile owns

A row owns the records it could conflict with at its rendered name and nothing
else: an address row owns its type and any CNAME there, a CNAME owns the whole
name, MX, SRV and CAA own their type, and a TXT row owns only TXT of its own
kind -- SPF, DKIM or DMARC. A TXT value of no known kind is only ever ensured,
so verification records beside SPF are never touched. Names no row renders are
never written. Taking a row out of a profile stops enforcing it and leaves what
it wrote. Ownership comes from names and kinds, not from record comments;
created records get a comment saying who manages them, and an updated record
keeps its own.

A name below the zone apex that is delegated by NS records, or an NS or SOA
record a CNAME row would replace, stops the site. Two sites in one zone whose
profiles want different records at the same name stop each other.

SPF is merged rather than replaced (RFC 7208): the published record keeps its
senders, their order, its `all` or `redirect=` ending and its modifiers, and the
profile's senders that are missing are added before the ending. Equivalent
terms match however they are spelled. Duplicate SPF records that end alike are
merged into one, saved before the duplicates go. Duplicates that end
differently, macros, fail or neutral terms before a pass, terms after `all`, or
a merge past ten DNS lookups are reported instead. A record that already names
every sender is left exactly as written.

## Report only and Enforce

The page puts the sites first, then the profiles with the choice of default,
then the connections and settings that are set once. Until a connection
exists it opens with the three steps that make a new site publish itself:
connect, choose the default, enforce it. A default profile in Report only is
called out, since its new sites get no records and so no certificate.

Report only reads Cloudflare and Mailcow and writes nothing. Enforce makes the
plan and keeps making it: every check corrects drift at the names the profile
owns, and deletes conflicting records there.

A change that would alter what an enforcing profile writes -- turning Enforce
on, editing an enforcing profile's rows or options, assigning sites to one, or
changing the server addresses, Mailcow settings or a zone choice they depend on
-- is not saved. It is planned against fresh reads and returned as a review of
every create, update and delete. A root-only pending file holds the proposed
policy, with any new Mailcow key that came with it, a random token, a digest of
the plan and a hash of the current policy, for fifteen minutes. Confirming
re-plans; a plan that changed in the meantime is shown again rather than
applied, and a policy that changed refuses the confirmation. A review in which
a site has a problem cannot be confirmed: fix the problem or take the site out
of the profile. A rename, a Report only edit or a change of mode to Report only
is saved directly.

## Zone options

A profile can set the zone's SSL/TLS mode and Always Use HTTPS, and ask for
three rules: Full SSL for `/.well-known/acme-challenge/`, Full SSL for
`webmail.` hosts, and a skip of Super Bot Fight Mode and managed rules for
listed addresses, such as a MainWP Dashboard. Cloudflare cannot skip the free
Bot Fight Mode this way.

These belong to the whole zone, so only enforcing profiles' wishes are written,
and a profile that disagrees with what its zone's enforcing profiles ask is
stopped. A Report only profile never writes, so it stops nobody else. Each rule
is one zone-wide rule with a fixed `ref`, added to the phase's entrypoint beside
whatever else is there, or updated in place; a rule that already does the same
thing, such as one Terraform created, counts as present. A zone therefore uses
at most one rule of each kind against its plan's quota. Rules are written before
records, so a proxied record never exists without the rule its first
certificate needs. The addon never deletes a rule.

Proxied records with the ACME rule are the default because they work with
Cloudflare IP Access: Let's Encrypt's HTTP-01 request reaches the origin through
Cloudflare with Full SSL while the origin still has CloudPanel's self-signed
certificate.

## Cloudflare connections

A connection is one API token. The page links to Cloudflare's user-owned token
template (`/profile/api-tokens` with `permissionGroupKeys`, `accountId=*` and
`zoneId=all`), so the operator chooses accounts and zones on Cloudflare's own
screen and never types an account ID. The permissions are the union of what the
saved profiles use: Account Settings Read, DNS Edit, Zone Read (Zone Edit if a
profile creates zones), Zone Settings Edit, Config Rules Edit and Zone WAF Edit
for the features that need them. The URL uses the keys in Cloudflare's
[template reference](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/),
plus `config_settings` and `zone_waf`, which the reference leaves out but the
form accepts. The dashboard drops an unknown key without saying so, which is
why the page also lists the permissions. The template has no parameter for
Client IP Address Filtering, so the page shows the server's detected addresses
to paste there. Their API permissions are
[Config Settings Write and Zone WAF Write](https://developers.cloudflare.com/ruleset-engine/rulesets-api/update/).
Cloudflare refuses a missing permission with a bare "Authentication error", so
a refused settings or rules read or write is reported with the permission it needs.

A token is verified before it is saved (`/user/tokens/verify`, or the account
route for an account-owned one, using a zone's account when account listing is
not permitted). Each check then lists every account and zone
each connection reaches, an account known from `/accounts` or from its zones. A
site belongs to the longest zone any connection reaches; moved, deleted and
deactivated zones are ignored. One zone reached by two tokens is used through
the first connection until the operator chooses another; two zones with the
same name, in different accounts, must be chosen between before either is
written. When the chosen zone cannot be reached, the choice is asked again
rather than falling back to the zone left over. A profile can create a missing zone, for the registrable domain, in an
account chosen from the ones its connections reach. While any connection cannot
be read, a site with no zone found is unreachable rather than missing, so a zone
only that connection reaches is never created again elsewhere. A new zone's
nameservers are shown; changing them at the registrar is the operator's.

## Mailcow

For a profile that uses Mailcow, a missing domain is added with Mailcow's usual
limits and `key_size: 0`, so Mailcow does not make a key of its own; then the
key is duplicated from a configured domain or generated with the configured
selector and size. A domain that has a key keeps it, and DNS publishes exactly
the selector and TXT Mailcow returns. The shared mailbox's sender list is read
fresh, the missing `@domain` entries added, written in one call and read back;
Mailcow replaces the whole list and has no compare-and-swap, so an edit made in
between can be lost. A Mailcow that does not report the list is noted rather
than overwritten. No Mailcow domain is ever deleted.

## New sites and certificates

DNS declares `newSites`, so the shared watcher (see
[Platform integration](platform.md#new-sites)) gives a new site the default
profile and enforces it, normally within seconds and before SMTP Relay, which
waits at most fifteen seconds for it.

Creating a site points its names at this server, so a new site's records are
created and its own address records -- A, AAAA or CNAME at the site and `www`
-- are replaced at once, with no review. If its profile would do more, such as
update or delete other records or change a zone setting, the site is held: its
rules are still written, but the rest waits, through every later check, until
an administrator reviews it. Placing the site in a profile by hand, or the
page's Review changes, runs the usual review and clears the hold. Readiness
ignores the held changes. One read of the panel that finds no sites changes no
assignment.

Panel Tweaks' completion page calls `POST /addons/dns/api/provision` before it
asks for a certificate. The route, and its CSRF session route, are reachable by
non-administrators: the action is told the panel user and refuses a site
`panelUserOwnsSite` does not give them, and answers with readiness, a reason (a
fixed one when a non-administrator's site has a problem, since a plan's problems
can name other sites and quote provider errors) and the certificate names only -- the site and `www` where the profile writes an
address there. A site in no profile or a Report only one is not DNS's to hold up.
A non-administrator's call checks Cloudflare only for a site created in the last
fifteen minutes; for an older one it answers from the last check, so repeating
it cannot keep the DNS lock and the provider's rate limit busy.
For an enforced site created in the last fifteen minutes that still has its
self-signed certificate, the call also records that automatic SSL was asked
for. When DNS was not ready -- a new zone waiting for its nameservers, say --
the 15-minute check retries it as root with `clpctl
lets-encrypt:install:certificate` once the site is ready: at the first check two
minutes or more after the request, then at the first check 5, 15, 60 and 360
minutes after each attempt, five attempts in all. The attempt is counted before the CLI
runs. A site whose certificate is no longer the placeholder ends its request,
so a real certificate is never replaced; a site DNS stops enforcing drops it.

## Running

Repair uses `queueAddonPass` to start the transient `clp-addon-dns-reconcile`
unit with a thirty-minute runtime bound, skipping a pass still running. A queued
pass checks that DNS is enabled after taking its lock. The global operation lock
is never held for Cloudflare calls. The pass runs the
full check: new sites, every assigned site read, enforcing sites enforced,
automatic SSL retried. Every action that writes takes DNS's own lock; the page
reads the last check without it and uses the shared `repaintView` after changes. Zones are read and written in parallel, one
zone's writes in order. There is no concurrency cap or rate limit of the
addon's own: each request has a 15-second deadline and an 8 MiB reply limit, no
redirects, and the shared bounded HTTP body reader. A 429 stores Cloudflare's or Mailcow's `Retry-After` (five
minutes if absent), after which no request is made to that provider until it
passes, across runs, including failed connection checks and unconfirmed plans.
A listing whose count changes mid-read, or that repeats or
misses an entry, is read again after half a second and then a second and a
half, since Cloudflare's list can lag its count just after a write, and is
refused if it still disagrees.

## State, secrets and removal

`/var/lib/clp-addons/dns/` holds `policy.json`, `secrets.json`, the last check,
tracked records, a pending review and automatic SSL requests, each root-owned,
mode `0600`, replaced atomically, and refused if it is not a root-owned regular
file of that mode. Tokens and the Mailcow key are read only by the root action
and travel only in request headers: never in arguments, page replies or logs,
and error text is redacted of them. A saved Mailcow key is kept only for the
Mailcow address it was saved with.

The records an enforcing site has as wanted are tracked by id and their full
record values, including priority, proxy, TTL and comment. A site taken out of
its profile, or into a Report only one, is forgotten there and then: its records
are its own again. When CloudPanel no longer has an enforced site, the page
lists them; Remove plans the deletion of those
still unchanged and at no name a current site's profile writes, and deletes
them after the same kind of review. It refuses while a site in that zone could
not be read or planned safely. Keep forgets them. Neither touches the zone or Mailcow.

Assigning no profile, Report only, deleting a profile, disabling and
uninstalling all stop enforcement and change nothing outside the server;
disabling also stops the periodic pass.
Uninstall removes the enabled flag and stops that pass before purging state.
