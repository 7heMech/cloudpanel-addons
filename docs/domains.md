# DNS & Mail

DNS & Mail keeps Cloudflare DNS and Mailcow domains in step with CloudPanel's
site list. Enable **DNS & Mail** in Addons, or run `clp-addons install domains`.
Its settings page is for CloudPanel administrators.

## Configure once

1. Open **Connections**. Enter your Cloudflare account ID and API token, plus
   the HTTPS origin and API key of your Mailcow instance. Keys are saved
   root-only and never shown again. A blank saved key keeps it only for the same
   account/endpoint. Saving connections returns profiles to Report only.
2. Edit **CloudPanel + Mailcow**, or create profiles for different setups.
   Replace the example mail IPs, mail/webmail hostnames and shared mailbox.
   Server IPs are detected; use overrides for NAT, multiple addresses or another
   origin. The shared Mailcow mailbox must already exist.
3. Choose the source domain whose DKIM key should be duplicated, or leave it
   blank to generate a key for each domain. Existing Mailcow DKIM keys are kept,
   and their actual public key and selector are what DNS gets.
4. Assign sites in the table, individually or in bulk. **Scan now** shows what
   each profile would create, update or delete. Report only changes neither
   Cloudflare nor Mailcow. Fix any plan errors, then **Review Enforce** and
   confirm the displayed changes. Assigning an existing fleet to Enforce also
   requires a reviewed plan.
5. Choose the **default for new sites**. This affects sites created from now on;
   it does not move the existing fleet. A confirmed enforcing profile is needed
   for automatic provisioning.

Cloudflare token permissions: **Zone Read** and **DNS Edit** on the relevant
zones. Enable **Zone Settings Edit** only for Strict SSL / Always use HTTPS;
enable **Zone > Config Rules > Edit** for the ACME/webmail configuration rules
and **Zone WAF Edit** for the MainWP skip. These are the product-specific zone
ruleset permissions; enable them only for the features you use. **Zone Edit**
is needed only to create missing zones. See Cloudflare's
[configuration-rule permissions](https://developers.cloudflare.com/rules/configuration-rules/create-api/)
and [WAF ruleset API](https://developers.cloudflare.com/waf/custom-rules/custom-rulesets/).
The Mailcow key needs read/write access to domains, DKIM and the configured
mailbox's sender ACL; restrict the key's source IPs to your CloudPanel server.

## Everyday use

With Panel Tweaks' automatic SSL enabled, create a site as usual and leave its
checkbox checked. The completion page records the SSL request, provisions DNS
and mail, and requests the certificate only once Domains reports ready, including
www when its address records are managed. It shows
the reason when something is not ready. The shared new-site watcher runs as
soon as CloudPanel writes a site, with another pass ten seconds later; DNS & Mail
runs first, followed by Cloudflare IP Access and SMTP. WordPress Tools keeps its
own maintenance cadence.

The default profile creates proxied A/AAAA, www only at the zone apex, one MX,
one merged SPF, Mailcow DKIM, autoconfig/autodiscover CNAMEs, the
autodiscover SRV, and an apex-only webmail CNAME to your hub. Strict SSL and
Always use HTTPS are on. Full SSL rules for HTTP-01 and webmail are installed
before proxying. This works with Cloudflare-only origin access. DNS-only is an
option, but Cloudflare-only access must be off for those sites. The alternative
"wait for certificate" mode also requires direct origin access initially.

Optional MainWP IPs bypass Super Bot Fight Mode and managed WAF rules for the
site. Cloudflare cannot bypass ordinary Bot Fight Mode with this rule; see its
[supported skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/).

Subdomain sites use the longest matching parent zone. If no zone exists, enable
zone creation or create it yourself. New zones show their assigned nameservers:
change these at the registrar manually. Until Cloudflare reports the zone
active, the completion page waits and no certificate is requested. Once ready,
the regular reconcile retries creation-time SSL requests while the certificate
is still self-signed, at most five root attempts. The page shows attempts and
status; **Retry SSL** resets an exhausted request for the next reconcile.
CloudPanel's CLI includes www when retrying an apex certificate, so its DNS
must also be managed. Existing real certificates are never replaced.

Use **Provision now** for an immediate check of a site's assigned policy, or
**Scan now** to refresh the whole fleet's plan without enforcing it. Drift is
checked every fifteen minutes. Provider-requested rate-limit pauses are shown.
Diagnostics are in `journalctl -u clp-addons-sites-reconcile.service` and
`journalctl -u clp-addons-domains-reconcile.service`. To run the full worker
manually: `clp-addons action domains reconcile`.

## What Enforce owns

Profiles define exact names and types through **Record templates**. Names must
stay inside the site. The shipped templates use placeholders listed in the
editor. Edit templates when a group needs fewer records, another target or a
different proxy setting. A hub domain whose webmail hostname would point to
itself needs its own profile with webmail A/AAAA templates instead of that CNAME.
The addon does not create mail-server A/AAAA, TLSA, PTR or mailbox records.

Enforce corrects managed values and deletes conflicts, including an unexpected
address, a conflicting CNAME and stale DKIM at the selector.
Verification TXT beside SPF and records at unrelated names are left alone.
NS/SOA conflicts block a change. Comments mark records for clarity but do not
decide ownership. Zone settings apply to every hostname in that zone; individual
addon rules preserve unrelated entrypoint rules.

The `{spf}` template adds the mail IPs and profile includes to existing SPF,
preserving its senders and ending policy, including `-all` or `redirect=`. When
there is no existing SPF, it creates one ending `~all`. Compatible duplicate
records are combined into one; the merged value is saved before extras are
deleted. Different ending policies or modifiers block enforcement for that
site. Malformed records, macros, non-pass mechanisms other than `all`, and
mechanisms after `all` also require manual review. The plan shows the reason;
resolve it in DNS or use a fully reviewed literal SPF TXT template for advanced
SPF. A literal template publishes exactly its configured policy, with no merge;
other verification TXT records remain untouched.
These rules follow SPF's [ordered mechanisms and fallback semantics](https://www.rfc-editor.org/rfc/rfc7208.html#section-4.6).

SPF additions are deliberately additive. Removing an include or changing a mail
IP in a profile does not revoke the old authorization already in DNS. Remove it
from the profile first, then remove the retired sender in Cloudflare. Additions
made directly in Cloudflare are retained; required profile terms are restored
if removed. This is a local merge, not recursive validation of included SPF
policies or their total DNS lookup count.

Changing a mode, unassigning a site or deleting a profile leaves external state
in place. Deleting a CloudPanel site lists its tracked DNS as **orphaned**.
**Remove records** shows a separate confirmation and removes only those tracked
records that are unchanged and unclaimed by current sites. Dashboard-modified
orphan records require manual review there. Mailcow domains and ACL grants are
never deleted automatically. Disabling/uninstalling stops enforcement and leaves
Cloudflare and Mailcow as they are; keeping addon data also keeps its inventory.

## Retire Terraform without deleting DNS

Stop Terraform automation first. Back up its state securely, then remove the
resources you are handing over from state with `terraform state rm`, or use
[`removed` blocks with `lifecycle { destroy = false }`](https://developer.hashicorp.com/terraform/language/block/removed).
Review the Terraform plan to ensure it will delete no remote records and will
not recreate resources you have removed. Never run `terraform destroy` as a
migration step. Remove or retire the corresponding resource declarations too.

Run DNS & Mail in Report only, assign the intended sites, review every create,
update and conflict deletion, and check SPF additions and Mailcow DKIM against
the actual service. Then confirm Enforce. Existing matching records are adopted;
there is no need to delete and recreate them. Redirect rules, Workers-owned
records, hub-server records and custom names need a separate handover decision.
