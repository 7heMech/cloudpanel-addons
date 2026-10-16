# DNS & Mail

## Source and ownership

CloudPanel's `site` table is the inventory. Named profiles hold DNS templates,
mail settings and an enforcement mode; assignments and the default for new
sites follow PHP Resources' model. Choosing a default records the existing site
ids, so it never reassigns an existing fleet. Explicitly assigning no profile is
also remembered. Removed sites lose their assignment on discovery; tracked DNS
is retained separately as orphans.

The page reads cached plans without waiting for the addon's operation lock.
Mutations and provider work are serialized under that lock, independently of
repair's global operation lock.

Templates expand only inside their site's name. The longest matching zone in
the configured Cloudflare account owns that site, including subdomain sites.
Optional zone creation uses the registrable domain and reports its assigned
nameservers. Creation does not change the registrar or make a pending zone
ready.

Management comes from template names and record families, never comments.
Address templates own their corresponding address type and conflicting CNAMEs;
even an empty IPv6 template still claims AAAA, so a stale IPv6 address cannot
silently serve another origin. CNAME templates claim conflicting record types
at that exact name. SPF owns only TXT beginning `v=spf1`, preserving verification
TXT beside it. DKIM owns TXT and conflicting CNAMEs at Mailcow's actual selector.
Other TXT templates own TXT at their exact name. NS/SOA conflicts block a site
instead of deleting delegation. Conflicting profile claims at a shared name
block both sites; identical desired records can be shared.

Existing matching records are adopted and given a `clp-addons:domains` comment
or tag. Existing comments and tags are preserved.
An update corrects a selected record; additional conflicting records are deleted
before creates. SPF consolidation saves the union on the retained record before
deleting duplicate SPF, so a failed update cannot discard another sender's terms.
Unrelated names remain dashboard-owned, even if they carry an
addon comment. Quoted TXT chunks and normalized DNS targets compare by value.
Editing a profile to stop claiming a name leaves those records in place.

The `{spf}` TXT template ensures a minimum set of positive mechanisms: mail IPs
and global/per-domain includes. Planning and fresh enforcement reads merge these
with existing mechanisms at each template's exact name. Existing sender order,
fallback (`all`, `redirect`, or implicit neutral), and modifiers are preserved;
equivalent terms are deduplicated. New SPF uses `~all`. Compatible duplicate
records form a deterministic union; different fallback policies or modifier sets
block the site. A conservative parser also blocks malformed/unsupported syntax,
macros, non-pass mechanisms other than `all`, and mechanisms after `all` rather
than reinterpreting an advanced policy. A reviewed literal SPF TXT template is
the explicit option for advanced policies: its value is enforced exactly, while
its SPF family claim still preserves other TXT. SPF macros in literal templates
are distinct from addon placeholders. No recursive SPF lookups are performed.
This follows [RFC 7208](https://www.rfc-editor.org/rfc/rfc7208.html).

SPF adoption is additive: terms present in DNS remain even after their removal
from a profile. Revocation requires removing the profile requirement and then
editing DNS. This avoids guessing whether a dashboard authorization belongs to
another sender. Required profile terms still return if deleted from DNS.

## Planning and enforcement

Report only makes no Cloudflare or Mailcow writes. New profiles and the shipped
CloudPanel + Mailcow profile start in this mode. The preset contains only
documentation addresses and example hostnames, no operator-specific setup.

Enabling Enforce, editing an enforcing profile, and assigning existing sites to
an enforcing profile prepare a plan without saving that policy. The browser
shows creates, updates, deletes and conflicts for DNS, Mailcow, zone settings
and rules. A root-only pending file binds a random confirmation token to the
current policy, connection credentials, site ids and provider plan. Confirmation
expires after fifteen minutes. Apply rereads provider state and refuses a
changed plan. Incomplete plans with site errors cannot enable enforcement.

After confirmation the policy is durable before external writes begin. APIs do
not offer a transaction across providers; partial failures remain visible and
the next reconciliation converges the confirmed policy. A missing DKIM key is
an explicit plan dependency: the generated public value cannot exist during
the read-only plan, so apply reads it back after Mailcow creates it, then diffs
DNS again. Report only never generates a key just to preview it.

## Creation and certificates

The shared Nginx-sites path trigger invokes `clp-addons sync-sites` outside the
global operation lock, runs addons in catalog order, and runs again ten seconds
later to catch CloudPanel's delayed database commit. DNS & Mail runs before
Cloudflare access and SMTP. Its fast path skips an unchanged, discovered fleet.
The existing Cloudflare IP Access minute timer is also retained as recovery.
Repair queues `clp-addons-domains-reconcile.service` without waiting; that worker
runs the full DNS/mail drift scan every fifteen minutes. Each API request has
a deadline, but there is no artificial fleet concurrency or request-rate cap.

The default proxy is on immediately. Scoped Full SSL configuration rules for
HTTP-01 paths and webmail are installed in `http_config_settings` before proxied
DNS writes; the remaining zone setting is Strict. Rules use stable site refs,
adopt equivalent entries, and update/add individual rules without replacing
the phase's unrelated rules. Zone settings affect the whole zone. Optional
MainWP rules skip the `http_request_sbfm` and `http_request_firewall_managed`
phases for configured IPs and site hostnames. Ordinary Bot Fight Mode cannot be
skipped by Cloudflare's Ruleset Engine.

DNS-only profiles are supported. The page warns when their sites restrict
origin access to Cloudflare. The optional certificate-gated proxy uses the
installed PEM's validity and hostname coverage, including separate coverage for
www, not merely a certificate row's presence. Such a profile needs direct
origin access for its initial HTTP-01 challenge.

Panel Tweaks records creation-time auto-SSL intent and calls the scoped provision
route before submitting its native certificate form. The provision action can
discover and apply only the site's assigned/default policy, never caller-chosen
records or credentials. A named non-administrator is checked root-side with
`panelUserOwnsSite`; the reply contains only readiness, a reason and the managed
site/www certificate names when ready. All other
DNS & Mail pages and actions remain administrator-only. CloudPanel itself treats
ROLE_SITE_MANAGER as fleet-wide; ROLE_USER is restricted through `user_sites`.

An active zone and a converged enforced plan are required for readiness. Pending
nameservers, missing zones, Report only and provider failures all postpone SSL.
Root retries read Panel Tweaks' site-id-bound intent, wait two minutes for the
browser attempt, and act only while the currently installed certificate type
is CloudPanel's self-signed placeholder. They never renew/replace a real or
expired real certificate. The staging CLI accepts
`clpctl lets-encrypt:install:certificate --domainName=DOMAIN --subjectAlternativeName=`;
its own apex behavior also requests www, so both managed names are required.
Five root attempts are allowed, with gaps of 5 minutes, 15 minutes, 1 hour and
6 hours, and the regular worker determining the actual next run.
The counter is written before invoking the CLI, including crash recovery.
An administrator can explicitly reset a requested site's retries. CloudPanel
continues to own certificate installation and later renewals.

## Mailcow

The addon adds missing domains, preserving existing domain configuration. Newly
created domains use Mailcow's conventional 10-mailbox, 400-alias, 10 GiB total
and maximum mailbox quota, and 3 GiB default mailbox quota. It never creates
the configured shared mailbox and never deletes a Mailcow domain.

Missing DKIM is duplicated from the selected source or generated with the
profile's selector and key size. Existing keys are retained regardless of that
choice; DNS publishes exactly the public TXT and selector read from Mailcow.
The public key and TXT must agree. Returned private-key fields and write logs
are discarded. Sender ACL changes reread the mailbox and merge all applicable
domains in one update, preserving grants present in that fresh read. Mailcow
replaces the ACL and provides no compare-and-swap operation; writes by independent
clients cannot be serialized across that read/write pair.
Unknown or absent ACL shapes block the change rather than treating them as
empty. No ACL grant is removed automatically.

## State, errors and removal

Connections offers Cloudflare's [user API token template URL](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).
The fixed Cloudflare dashboard URL encodes the union of all saved profiles'
permission requirements, including Report only/unassigned profiles: zone read
and DNS edit, plus settings, configuration rules, WAF, and zone creation only
when requested by a profile. Zone edit replaces zone read for zone creation.
The server renders the template and labels with each state reply; opening
Connections reads the latest data. The browser enables the external link only
for a valid account ID, scoped to all zones in that account, and clears its href
when the ID becomes invalid. No wildcard account scope is generated. Profile
values and credentials never enter the link. It opens without a referrer or
opener; the operator reviews the scope, creates the token and pastes it back.

Root-only `0600` JSON files in `/var/lib/clp-addons/domains` hold policy,
credentials, cached plans/inventory and the pending confirmation. Symlinked,
oversized, non-regular, wrongly owned or incorrectly permissioned files are
refused. Both tokens travel only in HTTPS request headers on the root action
side. They never enter command arguments, browser replies, remote-error logs
or provider-body diagnostics. Saving connections clears pending confirmation
and returns all profiles to Report only, including credential rotation.

Both providers use the shared bounded HTTP transport: HTTPS, no redirects,
15-second request/body deadline, 2 MiB response limit, validated JSON and
provider-specific envelopes. Cloudflare pagination must be complete, consistent
and free of duplicate ids before its records are used. The inventory is bounded
to one million entries. HTTP 429 persists the provider's Retry-After (seconds
or date); an absent/invalid header falls back to Cloudflare's documented
five-minute blocked window. Requests resume after the deadline on a later run.
Raw provider error messages are not reflected; Cloudflare codes and HTTP
status remain available.

Provider contracts follow Cloudflare's [DNS record API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)
and [individual rule API](https://developers.cloudflare.com/ruleset-engine/rulesets-api/update-rule/),
and Mailcow's [official OpenAPI schema](https://github.com/mailcow/mailcow-dockerized/blob/master/data/web/api/openapi.yaml).

The inventory retains adopted/created record ids and their last matching values,
including names a profile later stopped claiming. A deleted site is shown as an
orphan. Remove records builds a separate confirmed plan and refuses records
that changed in the dashboard or are still claimed by another current site.
Only tracked, unchanged DNS records are removed, never an entire zone, ruleset,
Mailcow domain or mailbox. Unassigning, switching modes, deleting a profile,
disabling or uninstalling does not withdraw external state. Workers check the
enabled config before API writes, and disabled units stop scheduling work.
