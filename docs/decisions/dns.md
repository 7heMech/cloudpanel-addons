# DNS

## Scope

DNS keeps each CloudPanel site's records to a profile across Cloudflare or
PowerDNS Authoritative API v1, so that creating a site is enough to publish it,
and serves redirect domains. Mailcow is an optional integration of a profile
that sets up the site's domain, its DKIM key, and a shared mailbox's permission
to send as it. The addon replaces infrastructure-as-code for these records
rather than coexisting with it. It follows the panel's site list, and once it is
Automatic what it writes cannot drift.

Nothing about one operator's setup is built in. The server's addresses are
detected, the Mailcow host, key policy, and mailbox are settings, and the
records are rows anyone can edit.

## Provider adapter and capabilities

`addons/dns/provider.ts` defines the provider-neutral `DnsProvider` interface
and `ProviderCapabilities` flags (`proxy`, `edgeRedirects`, `createZone`,
`autoTtl`, and `comments`). Before `diffRecords` runs,
`normalizeRenderedForProvider` strips `proxied` when `!capabilities.proxy` and
resolves `ttl === 1` (Auto) to `provider.defaultTtl` when
`!capabilities.autoTtl`.

- **Cloudflare (`addons/dns/cloudflare-provider.ts`).** Wraps
  `lib/cloudflare/api.ts`, sets all five capability flags to `true`, applies
  per-record POST/PATCH/DELETE calls in order, and exposes Single Redirect
  rulesets behind `.edge`. Zone-wide SSL/TLS, Always Use HTTPS, Full SSL rules,
  and WAF skip IPs live in [Firewall](firewall.md#cloudflare-edge-defaults).
- **PowerDNS (`addons/dns/powerdns.ts`).** Talks to PowerDNS Authoritative
  Server HTTP API v1 over `ProviderHttp` (`redirect: "error"`, `X-API-Key`
  header, 15-second deadline, 8 MiB response cap). Capabilities have `proxy`,
  `edgeRedirects`, `autoTtl`, and `comments` set to `false`, and `createZone`
  driven by the connection's `createZones` switch.
  - **Transport policy.** `parsePowerDnsUrl` accepts `https://` for any valid
    host and allows plain `http://` only for `localhost`, IPv4 loopback
    (`127.0.0.0/8`), RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`,
    `192.168.0.0/16`), RFC 6598 CGNAT (`100.64.0.0/10`, used by Tailscale), and
    IPv6 loopback (`::1`) or ULA (`fc00::/7`). Public plain `http://`, embedded
    credentials, query strings, and fragments are rejected. Editing a
    connection's URL without supplying a new API key is refused so a saved key
    is never sent to a different host.
  - **Canonical names and formatting.** Outgoing zone names, RRset names, and
    CNAME, MX, and SRV targets append a trailing dot; incoming names strip it.
    MX formats as `<priority> <target>.`, SRV as
    `<priority> <weight> <port> <target>.`, CAA as `<flags> <tag> "<value>"`,
    and TXT splits into master-file quoted strings of at most 255 UTF-8 octets
    per chunk without breaking multi-byte Unicode code points.
  - **Atomic RRset patching and synthetic IDs.** `applyRecords` groups touched
    `(name, type)` pairs, merges creates, updates, and deletes against the full
    zone inventory so unmanaged sibling records in the same RRset (such as
    verification TXT records beside SPF) remain untouched, and sends one
    `PATCH /api/v1/servers/{serverId}/zones/{zoneId}` using `REPLACE` with the
    RRset TTL or `DELETE` when no records remain. Because PowerDNS records have
    no UUIDs, each parsed record gets a deterministic synthetic ID
    `pdns:<sha256(type|name|priority|content)>` (disambiguated by raw wire text
    for non-canonical TXT formatting so unmanaged siblings stay verbatim) for
    orphan tracking in `managed.json`. PowerDNS Authoritative API v1 exposes
    only RRset-level `REPLACE` and `DELETE` with no member-level mutation or
    optimistic concurrency header; `clp-addons` serializes its own reads and
    writes under `dns.lock` and preserves unmanaged enabled and disabled RRset
    siblings read in the same pass in their original wire form, so external
    writers should not concurrently edit RRsets that DNS manages. Zone maps are
    keyed by `connectionId:zoneId` so two PowerDNS servers hosting identically
    named zones never collide and trigger a zone choice.
  - **Zone creation.** When `createZones` is enabled with configured
    nameservers, `createZone` sends `POST /api/v1/servers/{serverId}/zones` with
    `kind: "Native"` and canonical nameservers to fit MySQL-replicated PowerDNS
    deployments that do not use AXFR.
- **Follow-on providers.** Future Hetzner Cloud DNS (`api.hetzner.cloud/v1/zones`
  RRset API) and netcup CCP JSON-RPC DNS adapters implement `DnsProvider` with
  the same capability model and RRset/batch merging without changing `engine.ts`
  or `records.ts`.

Cloudflare-only UI controls hide when no Cloudflare connection exists (the Proxy
column and Find redirects in Cloudflare). When both Cloudflare and PowerDNS
connections exist, proxy controls note that they apply to Cloudflare zones only.

On zones where `capabilities.edgeRedirects` is `false`, redirect domains keep
their local stand-in site active on this server and write unproxied `A` and
`AAAA` records pointing to this server's addresses instead of Cloudflare's
`AAAA 100::` placeholder, while still applying non-web profile rows such as MX,
SPF, and DKIM. On zones where `capabilities.proxy` is `false`, the panel
hostname stays unproxied, hands off to matching unproxied wildcards, and makes
no proxy change when CloudPanel issues its certificate.

## Profiles

A profile is an ordered list of record rows plus an optional Mailcow switch.
Whole-zone Cloudflare edge settings (SSL/TLS mode, Always Use HTTPS, Full SSL
rules, and WAF skip IPs) belong to [Firewall](firewall.md#cloudflare-edge-defaults)
rather than DNS profiles. Sites are assigned in bulk, and one profile can be the
default for new sites, as in Resource Limits and SMTP Relay; choosing a default
or assigning a site records the site ids that exist then, so a default never
reaches back over the fleet.

A row has a type (A, AAAA, CNAME, MX, TXT, SRV, CAA), a name, content, proxy,
TTL, a priority for MX and SRV, and "apex only", which skips the row when the
site is not its zone's apex. The Web preset uses apex only for `*.{domain}`,
Mailcow uses it for `autoconfig`, `autodiscover`, `_autodiscover._tcp` and
`webmail`, and DMARC uses it for `_dmarc`, so subdomain sites inherit the apex
wildcard and policy without publishing extra names. Names and content take
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
Mailcow", produced on read so a deleted one stays deleted.

## What a profile owns

A row owns the records it could conflict with at its rendered name and nothing
else: an address row owns its type and any CNAME there, a CNAME owns the whole
name, MX, SRV and CAA own their type, and a TXT row owns only TXT of its own
kind -- SPF, DKIM or DMARC. A TXT value of no known kind is only ever ensured,
so verification records beside SPF are never touched. Names no row renders are
never written. Taking a row out of a profile stops keeping it and leaves what
it wrote. Ownership comes from names and kinds, not from record comments;
created records get a comment saying who manages them, and an updated record
keeps its own.

A name below the zone apex that is delegated by NS records, or an NS or SOA
record a CNAME row would replace, stops the site. Two sites in one zone whose
profiles want different records at the same name stop each other.

When a subdomain site wants only A or AAAA records at a name and an unobstructed
wildcard in the zone matches the exact address set and proxy state under RFC
4592, DNS omits those explicit records and deletes any redundant A, AAAA or
CNAME left at that name. Any record at or below the subdomain, or at an
intermediate ancestor with no wildcard of its own, stops a broader wildcard from
matching; DNS then writes explicit A and AAAA records and reports which record
blocked the wildcard. Within a zone, wildcard writers run first, redirects and
explicit or non-address writers next from deepest name to shallowest, blocked
explicit subdomain sites after those, and wildcard-covered sites last. Each site
re-plans against live zone records before writing, so redundant subdomain records
go only after the wildcard exists and no sibling record blocks it. Pre-enforce
planning runs two passes over problem-free siblings in scope so reviews preview
both planned wildcards and non-covered explicit sibling blockers, while
post-enforce saved plans and orphan checks evaluate strictly against live
records. Every relied-on wildcard stays in the site's wanted names, so removing
a deleted apex site's records never deletes a wildcard another managed site
uses. Changing a site whose profile has or had a wildcard row brings managed
subdomains in its zone into the same review, and changing a descendant or
intermediate-ancestor sibling brings affected managed subdomains along as well.

SPF is merged rather than replaced (RFC 7208): the published record keeps its
senders, their order, its `all` or `redirect=` ending and its modifiers, and the
profile's senders that are missing are added before the ending. Equivalent
terms match however they are spelled. Duplicate SPF records that end alike are
merged into one, saved before the duplicates go. Duplicates that end
differently, macros, fail or neutral terms before a pass, terms after `all`, or
a merge past ten DNS lookups are reported instead. A record that already names
every sender is left exactly as written.

## Ask first and Automatic

Until a Cloudflare connection exists, the page replaces the full workspace with
a focused first-run setup card that links straight to Connect Cloudflare and,
when stand-in redirects already exist, **Check now**, the Redirects card, and
the Ask-first bar or Automatic sync toggle.
Once connected, the page uses the shared `.section-shell` navigation to split
into five sections: Sites, Redirects, Profiles, Settings, and Activity. Deep
links such as `#dns-connection`, `#dns-panel-host`, and `#dns-mode` open the
matching section automatically.

The Sites section holds the site table, the Ask-first banner while Automatic is
off, and any deleted-site orphan records. It has the shared search from six
sites, filters for needs attention, changes waiting, not managed, and site
runtime, sorting on every heading, and desktop bulk controls that stay hidden
until at least one row is ticked. When only one Cloudflare connection exists,
each site's status line omits the redundant connection label. The Redirects
section holds Add redirect, Find redirects in Cloudflare, and the redirect
table, keeping redirects out of the site table's selection, filters, and sort.
On a phone each redirect card leads with source and target, DNS status, and the
profile with Edit and Details beside it, cutting past ten rows behind a Show
all button. A site's Details dialog leads with its status chip, problems, any
pending nameservers with per-nameserver copy buttons, pending changes, and
descriptive facts.

The Profiles section holds the record profiles and the default profile selector
for new sites. The Settings section holds the Automatic sync toggle,
Cloudflare connections, the New zones account picker when more
than one Cloudflare account is reachable, Panel hostname, and closed
disclosures for Mailcow and Server addresses that open automatically when
configured or overridden. The Activity section holds the change log.

There is one switch for the whole addon, not one per profile: the operator
decides once whether DNS may write, and every profile and missing zone follows
it. It starts in Ask first, which reads Cloudflare and Mailcow and writes
nothing; a bar above the sites says so, counts the changes and new zones
waiting, and offers the review that turns on Automatic. Automatic makes the plan
and keeps making it: every check corrects drift at the names the profiles own,
deletes conflicting records there, and creates a site's missing zone.

A change that would alter what DNS writes once Automatic -- turning it on,
editing a profile's rows or options, assigning sites, or changing the server
addresses, Mailcow settings, the account for new zones or a zone choice they
depend on -- is not saved. It is planned against fresh reads and returned as a review of
every create, update and delete. A root-only pending file holds the proposed
policy, with any new Mailcow key that came with it, a random token, a digest of
the plan and a hash of the current policy, for fifteen minutes. Confirming
re-plans; a plan that changed in the meantime is shown again rather than
applied, and a policy that changed refuses the confirmation. A review in which
a site has a problem cannot be confirmed: fix the problem or take the site out
of the profile. A rename, any edit while DNS asks first, and switching back to
Ask first are saved directly.

A policy file that has a mode on each profile instead is read as
Automatic only when every profile that has sites enforced; otherwise it asks
first, so no site starts being written without a review. Any legacy `zone` block
left on a profile in `policy.json` is ignored by `parseProfile`, preserved on
disk by `savePolicy` until `migrateCloudflareEdgeFromDns` finishes moving it to
Firewall's Cloudflare edge state, and kept ahead of DNS repair by skipping DNS's
repair hook in `cli/repair.ts` whenever startup migration fails while legacy DNS
state is still pending.

## Redirect domains

A redirect domain is a source host, a target URL, a status (301, 302, 307 or
308), keep path and keep query string, and optionally a profile. The source is a
zone's apex, which covers its `www` too, or one host in a zone that holds other
things; `www` is added only to an apex. A redirect domain is planned beside the
sites, through the same switch, reviews, log and lock, but listed in a
Redirects card of its own, where its profile is chosen in Edit. It cannot be a CloudPanel site:
adding one for a site's domain is refused, and a site created later at a
redirect's domain stops the redirect with a problem.

On Cloudflare it is one Single Redirect rule in the zone's
`http_request_dynamic_redirect` entrypoint, with a `ref` of
`clp_dns_redirect_` and a hash of the source, and a proxied `AAAA 100::` at each
host it answers for. With keep path the target is
`concat("<target>", http.request.uri.path)`, so a target that keeps the path
may have no query string and loses a trailing slash; without it, a static URL.
There is no ACME exclusion, since the origin is never reached. The rule is
written before the placeholders, so a placeholder never answers without it.

Its profile's web rows are left out and every other row applies, so mail and
its DKIM key follow the profile as they do for a site. A web row is derived,
not marked: an A, AAAA or CNAME row whose rendered name is the source, its
`www` or its `*.`. Nothing else could live there, since the placeholder needs the name, so
no row needs a flag and no profile needs editing. The placeholder claims A and AAAA at each host, and so any CNAME there, which is
what replaces the A and AAAA records a site or Terraform left. A missing zone is
created the same way as for a site.

A rule another tool wrote is taken over in place. Matching by `ref`, or by an
equivalent rule as `ruleState` does for zone rules, would add a second rule
beside one that differs, as Terraform's do (they skip Let's Encrypt's path, and
some append the path to a target that is one page). So the redirect's rule is
the rule with its `ref`, or any rule whose expression quotes one of its hosts.
One such rule that tests only whole hosts (`http.host eq`, `==` or `in`, with
Let's Encrypt's path optionally left out), all of them the redirect's, is
updated in place with our `ref`. Anything else -- two rules, or one that names a
host another way -- is a problem on the plan, to be fixed in Cloudflare. A rule
is found by its hosts on every check, so it is kept whether or not Cloudflare
keeps the `ref` an update sets; should Cloudflare refuse to change a rule's
`ref`, the update is made again with the rule's own.

**Find redirects in Cloudflare** reads the redirect entrypoint of every zone
the connections reach and lists the rules that redirect one whole host,
or an apex and its `www`, to a fixed URL or one with the path appended, which
no redirect domain or site has. Each fills a redirect's source, target, status,
keep path and keep query string, and a selection is added in one change, which
once Automatic is one review.

Deleting a redirect domain while DNS asks first stops managing it. Once
Automatic, a connected Cloudflare is checked for a rule even while a stand-in
still serves the domain. A rule is deleted through a review; its records stay,
for a site's profile to replace. A stand-in stays until that deletion is
confirmed. A rule conflict blocks both deletions, and so does a rule that
cannot be looked for: a connection that fails, or a zone reached through more
than one connection with none chosen, could hide one.

### Stand-in sites

With no Cloudflare connection, nothing in Cloudflare is DNS's, so a redirect is
served from this server: a CloudPanel static site whose vhost returns the
redirect for the source and, for a registrable domain, its `www`, and serves
`/.well-known/acme-challenge/` from the site's root; a target with a query
string gets the request's after `&`. The body is written to the
panel database as well as nginx (`lib/site-vhost.ts`), since CloudPanel renders
the file again from it, as it does when a certificate is installed. Each
reconcile pass asks Let's Encrypt, through `clpctl`, for a stand-in still on
its self-signed certificate: at the first pass after it is created, then 15
minutes, an hour and six hours after a failed attempt, and daily from then on,
since the domain may be pointed here at any time. A stand-in is a write
like any other: it waits for Automatic, is logged, and a profile assigned to it
waits for a connection.

`standins.json` records each one with its site user before CloudPanel creates
it, so the new-site work of every addon already sees it, and adds CloudPanel's
site id once the site exists. The user ends in eight random hex digits, which
no one picks in the panel, so a site with it is the stand-in's even before its
id is recorded: a failed creation deletes only a site with that user, and one
interrupted before the id was saved takes the id from that site on the next
pass. A record counts only while the panel site at its
domain has that user and id, or that user for the few minutes it is being
created (`lib/stand-ins.ts`): a site added there after the stand-in was deleted
in CloudPanel is an ordinary site. DNS otherwise changes or deletes only a site
whose id it recorded, and makes no stand-in where a site
already exists. If creation fails and CloudPanel also refuses to delete the
site, DNS keeps its ownership record so a later deletion can still identify
the site, and reports both failures. The record stays marked incomplete until
the vhost is written, so a later pass writes it rather than taking a static
site that does not redirect for a working stand-in.
DNS leaves stand-ins out of its site list through `isStandInSite`, and Stager,
Maintenance, SMTP Relay and Firewall through `withoutStandIns` in
`lib/panel-db.ts`. The panel snapshot the Git, Maintenance, Stager and Terminal
pages read leaves them out too. Resource Limits and WordPress Tools never list a
static site, and Panel Tweaks shows "Redirect" as its runtime on the Sites page. Global maintenance mode reaches a
stand-in as it does every vhost.

Adding a connection holds every redirect a stand-in serves, and removing the
last one holds every redirect: its whole plan waits until it is reviewed, like
a held new site, so a move between Cloudflare and this server is seen first. Once its rule and records are in and its zone is active, the
stand-in site is deleted. Deleting a redirect domain deletes its stand-in at
once unless a Cloudflare rule needs a review first; then confirming the review
deletes both.

## Panel hostname

The panel hostname is a third kind of entry beside sites and redirect domains,
planned through the same switch, reviews, log and lock, with a fixed profile:
A and AAAA at the name and no mail. Saving a panel hostname requires at least
one DNS connection, and `list` also exposes CloudPanel's existing custom domain
when `panelHost` is unset so Settings can offer one-click adoption. While DNS is in Ask first, saving a
panel hostname reports that records wait until Automatic is turned on. When a
panel hostname plan has a problem, the card shows the error once and hides the
next-step CloudPanel prompt. The
page offers a Random button that generates an eight-character unambiguous
lowercase label starting with a letter from `a-z` and continuing with `a-z` and
`2-9`, excluding `i`, `l`, `o`, `0` and `1`, and suggests connected zone names,
while keeping the field editable. Let's Encrypt publishes issued leaf
certificate names in public Certificate Transparency logs, so a random label
avoids obvious guessing while Firewall's Panel gate is what blocks access if the
name is found via CT logs. It cannot be a site's or a redirect's name; one
created later at it stops it with a problem. It asks for no certificate, since
CloudPanel issues the custom domain's own, and its records are tracked like a
site's, so removing it lists them with the records of deleted sites.

Its records are unproxied until CloudPanel's custom domain is that name and
serves a certificate a CA issued for it (`lib/panel-custom-domain.ts`), then
proxied, or deleted when an unobstructed proxied wildcard in the zone already
covers the hostname and matches the server's addresses. Saving the custom domain in CloudPanel writes the vhost with a
placeholder certificate, the Let's Encrypt one about six seconds later, then
`/etc/.clp_custom_domain`, all from one HTTP-01 check made at once. Direct, the check works whatever the zone's settings; proxied, it needs Full SSL,
and under Flexible the vhost's redirect to HTTPS loops. Renewals come through
Cloudflare once the name is proxied, which Firewall's Cloudflare edge ACME rule
covers. CloudPanel has no `clpctl` command for its custom domain, so the
operator enters it in the panel.

The certificate watcher runs `sync-panel-host`, which compares the proxy state
the last plan used with the one the certificate calls for and reaches Cloudflare
only when they differ, so a renewal costs two file reads; the scheduled check
covers anything it missed. CloudPanel writes `/etc/.clp_custom_domain` a moment
after the certificate, and the watcher's second pass three seconds later finds
it. The state is recorded only once Cloudflare holds the plan, so a write that
failed is tried again, and a site or redirect domain with the name keeps the
watcher from waiting on DNS's lock. Under Ask first nothing is written.

### Custom Domain helper on Admin Settings

DNS also injects a `custom-domain-dns` helper (`addons/dns/inject/custom-domain.ts`,
`required: false`) after the Custom Domain input group in
`Admin/Settings/index.html.twig`. None of its controls carry a `name` attribute,
so Symfony never rejects extra form fields. On page load the script warms the
CSRF cookie via `GET /addons/dns/api/session` and reads
`GET /addons/dns/api/panel-host-helper` (admin verb `panel-host-helper`), which
answers from local state alone (`connected`, `automatic`, `hasCloudflare`,
`hasPowerDns`, `zones`, `zoneProviders`, `panelHost`, and `serverIps`) with no
DNS lock and no provider call. When no Cloudflare or PowerDNS connection exists,
the script renders nothing.

When a connection exists, the helper adds a `Random` button beside the Custom
Domain field, attaches a `<datalist>` of connected zones, and adds an inline
checkbox that auto-checks when the entered hostname belongs to a connected zone
and unchecks with a note otherwise (adjusting proxy wording to the resolved
zone's provider). Submitting CloudPanel's form with the checkbox ticked sends
`POST /addons/dns/api/panel-host` with `{ name, prepareOnly: true }`, which
plans only the panel hostname's `A`/`AAAA` records (unproxied on Cloudflare)
against live provider records in both Automatic and Ask first modes without
touching other sites or Mailcow. A confirmation `<dialog>` shows the planned changes or problems;
confirming sends `POST /addons/dns/api/confirm`, writes only the panel hostname
while leaving `policy.automatic` unchanged, and returns the updated panel plan
including `zone.status`, `zone.nameServers`, and `zoneCreated` when the pass
just created the zone. If `zone.status` is not `"active"` or `zoneCreated` is
true (for example a newly created PowerDNS zone that reports `"active"` before
registrar delegation), the helper stops before submitting CloudPanel's form and
renders `lib/nameserver-notice.ts` with per-nameserver copy buttons. When an
existing active zone is ready (either with the written records or covered by an
unobstructed unproxied wildcard), the helper submits CloudPanel's native form
once, bypassing its own submit listener.

## Cloudflare connections

Cloudflare connections are shared across DNS and Firewall in the root-owned
`/var/lib/clp-addons/cloudflare/` store (`lib/cloudflare/store.ts`), managed by
the manager's `/addons/api/cloudflare` routes as well as DNS's Settings tab.
Both addons use the same Connect Cloudflare dialog
(`lib/cloudflare/connect-dialog.ts`), where the operator selects scopes for DNS
records, Cloudflare edge defaults, Panel gate, or any combination, and the
template link updates live.

A connection is one API token. The dialog links to Cloudflare's user-owned token
template (`/profile/api-tokens` with `permissionGroupKeys`, `accountId=*` and
`zoneId=all`), so the operator chooses accounts and zones on Cloudflare's own
screen and never types an account ID. For DNS records the permissions are DNS
Edit, Zone Edit, Account Settings Read, Single Redirect Edit and API Tokens
Read. Single Redirect Edit is included before any redirect domain exists so
finding redirects to take over works with the first token. API Tokens Read lets
the token read its own permissions; it exposes token metadata, never a secret.
Zone Edit is included for Automatic zone creation; Cloudflare refuses a zone
create without it by naming `account.zone.create`, which the page reports as
Zone Edit. Selecting Cloudflare edge defaults adds Zone Settings Edit, Config
Rules Edit, and Zone WAF Edit (when WAF skip IPs are configured). Selecting
Panel gate adds SSL and Certificates Edit, Access: Apps and Policies Edit, and
Access: Organizations, Identity Providers, and Groups Edit. The URL uses the
keys in Cloudflare's
[template reference](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/),
plus `config_settings`, `zone_waf` and `dynamic_redirect`, which the reference
leaves out but the dashboard accepts. The dashboard drops an unknown key without
warning, so the dialog also lists each permission by name. Because the template
has no parameter for Client IP Address Filtering, the dialog shows the server's
detected addresses with copy buttons. Their API permissions are
[Config Settings Write and Zone WAF Write](https://developers.cloudflare.com/ruleset-engine/rulesets-api/update/),
and Single Redirect's is
[Dynamic URL Redirects Write](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/).
Cloudflare refuses a missing permission with a bare "Authentication error", so
a refused settings or rules read or write is reported with the permission it needs.

`lib/cloudflare/tokens.ts` is the single list of permissions: each entry records
its dashboard label, template key, API permission group names, scope, consumer
(`dns`, `edge`, `panelGate`, or `shared`), and what uses it. The token template,
refusal messages, and permission tables in DNS and Firewall all derive from it.

### What a token holds

A check of every site, and saving a connection, reads the token's own
policies after verifying it; a check of some sites keeps the last read, as does
a read Cloudflare could not answer (a 429, a 5xx or no reply): verify returns the token's ID, then `/user/tokens/{id}`, or
`/accounts/{account}/tokens/{id}` for an account-owned token. Those need API
Tokens Read, or Account API Tokens Read for an account-owned token; a token
without it is still checked as before, and the page asks for that permission
instead of showing what the token holds. Its row then lists the permissions
Cloudflare refused it: the client records each refusal it names, and the check
stores them on the connection. A check of some sites adds to what the last full
check found, and only another full check clears them: a call that succeeded on
one zone says nothing of another that refused it. A refusal also wins over a permission the policies say the token holds, as an IP
restriction or a policy read wrongly would refuse it.
[Token details](https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/get/)

The read is stored with the connection's status, so the page makes no
Cloudflare call when it loads. The token's policies are kept as allow or deny
grants of permission group names over resources, and decided locally:

- Permissions are matched by group name ("DNS Write", "Zone WAF Write"), since
  Cloudflare does not publish group IDs. A Read requirement is met by Read or
  Write.
- [Resources](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)
  are `com.cloudflare.api.account.zone.*` (every zone), `…account.zone.<id>`,
  `…account.<id>` (an account, and its zones), the same account key nested
  with zone keys, and `com.cloudflare.api.user.<tag>`. A deny wins over an allow.
  A policy on a resource in another form makes only the permissions it names
  not known, and only where it could change them: an allow where they read as
  missing, a deny where they read as held.
- Zone permissions are checked against every zone the token lists, account
  permissions (Zone Edit, Account Settings Read) against every account. The
  page shows a held permission, a missing one, or one missing on some zones,
  naming up to three. It lists only what the profiles use, and names what is
  missing, never a count.
- The zones a token reaches are described from where DNS Write is allowed,
  less the denies that overlap it: all zones, all zones in named accounts, or a number
  of chosen zones.
- With no zone or account listed to check against, only a grant on every zone
  or account, with no deny for that permission, counts as holding it.
- A permission group without a name makes the whole read unavailable, rather
  than reading as a permission the token lacks.
- The token-reading row is API Tokens Read for a user token and Account API
  Tokens Read for an account-owned one.

A permission can be optional: nothing in the profiles requires it, and
`enables` says what it would turn on. It is listed after the required ones,
never as missing, and left out of the template; its row reads "Not added" until
the token holds it, or "—" when the token cannot read itself. None is optional
yet; Firewall's login jails and panel gate add theirs when they use them.

`connectionPermissions(stored, profiles, options)` in `lib/cloudflare/access.ts`
gives the Setup checklist, from a connection's entry in
`/var/lib/clp-addons/cloudflare/status.json`, whether the token read itself and
which required permissions it is missing or was refused, by name.

Cloudflare has no address for editing one token, so **Edit in Cloudflare**
opens the owner's token list: `/profile/api-tokens`, or
`/{account}/api-tokens` for an account-owned token.

Other addons ask through `cloudflareTokenHolds(connectionId, permission, zone)`
in `lib/cloudflare/store.ts`, which answers from the stored read without a
network call, checking each permission at its own scope (the zone, its account,
or the token's owner). It returns null when that is not known: no check yet, a
token no longer active or that cannot read itself, or a policy not understood
that could change the answer.

Zone-scoped IP Access rules (`/zones/{zone_id}/firewall/access_rules/rules`)
need **Zone → Firewall Services → Edit**, API name Firewall Services Write
(Firewall Services Read only lists them); template key `firewall_services`, as
the dashboard uses, which the template reference does not list. It is not in
the permission list yet. Cloudflare allows
[50,000 IP Access rules per account](https://developers.cloudflare.com/waf/tools/ip-access-rules/)
on every plan, while the Free plan allows only
[one custom list](https://developers.cloudflare.com/waf/tools/lists/).

Firewall's [Panel gate](firewall.md#panel-gate) needs SSL and Certificates:
Edit on the custom domain's zone (API name SSL and Certificates Write, key
`ssl_and_certificates`) and, on its account, Access: Apps and Policies: Edit
(Access: Apps and Policies Write, `access`) and Access: Organizations, Identity
Providers, and Groups: Edit (Access: Organizations, Identity Providers, and
Groups Write, `access_acct`). In DNS's permission table they appear as optional
and stay out of the DNS-only template unless the operator selects Panel gate in
the connect dialog; Firewall's own table marks them required.

A token is verified before it is saved (`/user/tokens/verify`, or the account
route for an account-owned one, using a zone's account when account listing is
not permitted). Each check then lists every account and zone
each connection reaches, an account known from `/accounts` or from its zones. A
site belongs to the longest zone any connection reaches; moved, deleted and
deactivated zones are ignored. One zone reached by two tokens is used through
the first connection until the operator chooses another; two zones with the
same name, in different accounts, must be chosen between before either is
written. When the chosen zone cannot be reached, the choice is asked again
rather than falling back to the zone left over. A site no connection has a zone
for gets one, for its registrable domain, in the account for new zones: the one
chosen under Settings, or the only account the connections reach. With several
and none chosen, the site's plan has a problem that asks for one, since putting
a customer's zone in the wrong Cloudflare account is not a guess to make. While
any connection cannot be read, a site with no zone found is unreachable rather
than missing, so a zone only that connection reaches is never created again
elsewhere. A new zone's nameservers are shown, and logged; changing them at the
registrar is the operator's.

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

The settings are the hostname, the API key, the DKIM policy and the shared
mailbox. Mailcow serves its API, webmail and mail on one `MAILCOW_HOSTNAME`, so
the address is entered as that hostname (an HTTPS origin, port included, is
also accepted) and `{mailcow.host}` is always its hostname rather than a second
field.

SMTP Relay is where a Mailcow relay mailbox is entered, because it holds the
mailbox's password; DNS reads it, not the other way round. The `list` reply
carries each SMTP Relay profile's relay host, username and name, read from
SMTP Relay's root-owned configuration with that addon's own parser and never
its password; a missing or untrusted file gives none. The Mailcow form offers
them, and fills the only one in when Mailcow is not yet set up. It is an import,
not a link: the values are copied into DNS's settings when saved, so changing a
relay in SMTP Relay never changes what DNS writes without a review. The API
key is DNS's alone, since SMTP Relay has no use for it.

Removing Mailcow deletes the key and empties the settings at once, like
removing a Cloudflare connection, with no review: nothing is written anywhere.
Sites whose profile sets up Mailcow then plan with a problem, and a plan with a
problem is never applied, so their records and Mailcow domains stay as they
were.

## New sites and certificates

DNS declares `newSites`, so the shared watcher (see
[Platform integration](platform.md#new-sites)) gives a new site the default
profile and, once DNS is Automatic, writes it, normally within seconds and before SMTP Relay, which
waits at most fifteen seconds for it. When DNS is Automatic and Panel Tweaks is
enabled with `autoSsl` turned on (checked from Panel Tweaks' enable flag and its
root-owned `tweaks.json`, with missing or untrusted files treated as off),
`sync-sites` and `check` also enqueue newly adopted self-signed sites created
within `NEW_SITE_WINDOW` (fifteen minutes) into `ssl.json` via `requestSsl`.
Sites created through `clpctl`, or whose browser completion tab closed early,
still receive automatic Let's Encrypt retries once DNS is ready.

Creating a site points its names at this server, so a new site's records at
names with no published records yet, including a missing `*.{domain}` wildcard,
and its own address records at the site and `www`, are written at once with no
review. If its profile would do more, such as update, delete or add beside an
existing record at `*.{domain}` or another name, the site is held: its own
address records are still written, and the rest waits, through every later
check, until an administrator reviews it. While an apex site's wildcard waits
for review, `www` is left out of its certificate names. Placing the site in a
profile by hand, or the page's Review changes, runs the usual review and clears
the hold. Readiness ignores the held changes. One read of the panel that finds
no sites changes no assignment.

Panel Tweaks' completion page calls `POST /addons/dns/api/provision` before it
asks for a certificate. The route, and its CSRF session route, are reachable by
non-administrators: the action is told the panel user and refuses a site
`panelUserOwnsSite` does not give them, and answers with readiness, a reason (a
fixed one when a non-administrator's site has a problem, since a plan's problems
can name other sites and quote provider errors), a pending or newly created zone
with its provider, nameservers, and `zoneCreated` flag, and the certificate
names only: the site and `www` where the profile writes an address there, or
covers `www` through an unobstructed wildcard. A site in no profile, or any site
while DNS asks first, is not DNS's to hold up.
A non-administrator's call checks the DNS provider only for a site created in
the last fifteen minutes; for an older one it answers from the last check, so
repeating it cannot keep the DNS lock and the provider's rate limit busy.
When DNS creates a brand-new zone during `sync-sites` or `provision`, `record`
stores its `connectionId:zoneId`, creation time, and nameservers in
`status.json` for `NEW_SITE_WINDOW` (clearing a Cloudflare entry sooner once a
later run sees that zone `active`). If `provision` creates the site's zone
directly or sees a matching recent creation in `status.json`, including a
PowerDNS Native zone whose API reports `status: "active"` immediately before
registrar delegation propagates, `provision` answers with `ready: false`,
`zoneCreated: true`, the zone name, its provider, and its nameservers so the
completion page pauses immediate Let's Encrypt issuance. Later `reconcile`
passes still evaluate `readiness(plan)` directly, so PowerDNS sites retry
`clpctl lets-encrypt:install:certificate` automatically once the initial
two-minute delay elapses.
For a site DNS writes, created in the last fifteen minutes, that still has its
self-signed certificate, `provision` with `--ssl` also records that automatic
SSL was asked for (idempotent with `sync-sites`). When DNS was not ready, or
when immediate browser issuance paused for a new zone or never completed, the
15-minute check retries it as root with `clpctl lets-encrypt:install:certificate`
once the site is ready: at the first check two minutes or more after the
request, then at the first check 5, 15, 60 and 360 minutes after each attempt,
five attempts in all. The attempt is counted before the CLI runs. A site whose
certificate is no longer the placeholder ends its request, so a real certificate
is never replaced; a site DNS stops writing drops it.

A site's SSL/TLS tab, the one the panel's certificate badges link to, carries a
notice while its zone waits for nameservers, since that is what the certificate
is waiting for. It says what happens to the certificate first and ends on the
one thing to do: the sentence naming the nameservers. Each nameserver sits in
that sentence with a clipboard icon, the two forming one button that copies
that nameserver alone, since a registrar usually has a field per nameserver.
The notice is `lib/nameserver-notice.ts`, shared with Panel Tweaks' completion
page, which fills it from `provision`'s reply.
It says the certificate is requested automatically only when DNS has recorded
a request for the site; a site still on its self-signed placeholder without one
is told to request it under Actions, and a site with a real certificate is told
nothing about it. A copy the browser refuses selects the nameserver instead. Anyone who
can open the site's page sees it, so it is fetched from
`GET /addons/dns/api/site`, the third route a non-administrator reaches; the
action holds a non-administrator to their own sites as `provision` does. It
answers from the last check, never from Cloudflare, so opening a page costs no
provider call and needs no DNS lock, and it carries the zone, its status and the
nameservers only while the zone is pending -- nothing a plan's problems would
reveal about other sites. Without a pending zone the page shows nothing.

## Running

Repair uses `queueAddonPass` to start the transient `clp-addon-dns-reconcile`
unit with a thirty-minute runtime bound, skipping a pass still running. A queued
pass checks that DNS is enabled after taking its lock. The global operation lock
is never held for Cloudflare calls. The pass runs the
full check: new sites, every assigned site read and, when Automatic, written,
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

## Change log

Every write DNS makes to Cloudflare, Mailcow or a stand-in site -- a zone
created, a record created, updated or deleted, a zone setting or rule, a
redirect rule, a Mailcow domain, DKIM key or sender list, a stand-in site -- is
logged once it succeeds, with the time, the sites it was
for, the zone, what it was before where that is known, and what made it: a
scheduled check, Check now, a new site, a confirmed review, Remove records or a
deleted redirect.
Each run collects its writes and they are saved before the page's reply and
again when the action ends, so writes made before a failure are kept. The log is the newest thousand writes; once Cloudflare is connected, the
Activity section shows the newest ten and puts the rest of the first two
hundred under a disclosure. With nothing logged, Activity still shows its empty
state and explains when Ask first is why. Provider errors are not logged: they
repeat every check and are already on the site's plan.

## State, secrets and removal

`/var/lib/clp-addons/cloudflare/` holds the shared Cloudflare connections
(`connections.json`), their API tokens (`secrets.json`), and their last check
reports (`status.json`). `/var/lib/clp-addons/dns/` holds `policy.json`
(including PowerDNS connection settings), `secrets.json` (PowerDNS API keys and
the Mailcow API key), the last check, tracked records, a pending review,
automatic SSL requests, the stand-in sites, and the change log. Each file is
root-owned, mode `0600`, replaced atomically, and refused if it is not a
root-owned regular file of that mode. Tokens, PowerDNS API keys, and the
Mailcow key are read only by root actions and travel only in request headers,
never in arguments, page replies, or logs, and error text is redacted of them. A
saved PowerDNS API key or Mailcow key is kept only for the URL it was saved
with.

The records a site DNS writes has as wanted are tracked by id and their full
record values, including priority, proxy, TTL and comment. A settled enforcing
entry handed off to a wildcard with no pending changes and no matched records of
its own clears its tracked entry so it leaves no orphans. A site taken out of
its profile, or every site when DNS goes back to Ask first, is forgotten there
and then: its records are its own again. When CloudPanel no longer has such a
site, the page
lists them; Remove plans the deletion of those
still unchanged and at no name a current site writes or relies on, and deletes
them after the same kind of review. It refuses while a site in that zone could
not be read or planned safely. Keep forgets them. Neither touches the zone or Mailcow.
When every connection, the one that wrote them among them, lists its zones
and none lists theirs, the zone was deleted and its records with it: a check
or Remove forgets them and logs the zone as deleted. Cloudflare answers such a
zone's reads with Authentication error, so only the listing tells it apart.
While any connection could not list its zones, nothing is forgotten.

Assigning no profile, Ask first, deleting a profile and disabling all stop DNS
writing and change nothing outside the server; disabling also stops the
periodic pass.
