# Cloudflare IP Access

## CloudPanel state

The addon manages CloudPanel's existing `allow_traffic_from_cloudflare_only`
site setting. Enabling it updates the site row, changes the rendered access log
from `main` to `cloudflare`, and adds
`include /etc/nginx/cloudflare/ips;` to that site's Nginx vhost. Disabling it
reverses those rendered-vhost changes. CloudPanel remains the source of the IP
ranges in `/etc/nginx/cloudflare/ips`.

Bulk changes take one exclusive addon lock and one immediate SQLite transaction.
Every affected vhost must be a trusted regular file. The trust checks, owned
atomic replacement, restoration and recovery error collection are shared with
WordPress sign-in in `cli/nginx-transaction.ts`. The action stages all
changes, runs `nginx -t`, reloads Nginx once, and commits the database only when
the reload succeeds. On failure it restores the original vhosts while holding
the SQLite write lock, then rolls back the database. If any recovery step fails, the action attempts the remaining
steps and reports each failure with the original operation error.

## Dashboard

"Enable all sites" and "Disable all sites" are one-time changes to the sites
that exist now, sent as a single bulk request. Their confirmation names the
scope, how many sites change setting, and how many automatic exceptions the
request rewrites; an operation that would change neither is reported and not
sent. Nothing is restored afterwards, so the dialog says so rather than offering
an undo the action does not implement.

Selection checkboxes stay separate from the per-site switch, and the
selected-scope actions are unavailable until something is selected. On desktop,
the checkbox remains visible; at 940px or narrower, where rows become cards, the
whole site row selects with a highlight and the checkbox disappears to give the
site card its width back. Mouse clicks on the row and Enter or Space on its
focused row select it, while the switch and other controls keep their own
actions. A per-site switch acts immediately without confirmation, because
turning one site off is the ordinary correction after a fleet-wide change.

After any change the page repaints from a fresh read rather than from what was
requested, keeping selection and scroll, and does the same after a failure so
the displayed state is the server's. A changed site inventory replaces the view
with the HTML returned by that read, preserving selections for surviving sites.
That read is part of the change: the controls stay disabled until it returns, so
a second action cannot overtake the first, and a change whose read failed is
reported as done but possibly out of date rather than as plain success.

## New-site policy

The optional policy records CloudPanel site IDs that already existed when the
policy was enabled. A root-only systemd timer checks once a minute. An unseen
site ID is treated as a newly created site and receives Cloudflare-only access.
This also handles deletion and recreation of the same hostname because the new
site has a new ID.

Turning a site off in the addon records its hostname as an exception. The timer
does not re-enable an exception. Turning the site on removes the exception.
Enabling or disabling the policy does not change existing sites; operators use
the dashboard's bulk controls for that.

## Cloudflare-only bypass protection

Cloudflare IP Access owns **Mitigate Cloudflare-only bypass**, enabled by default.
It applies only to sites whose public server includes CloudPanel's Cloudflare-only
rules. Turning that setting off for a site removes the include, so this protection
adds no restriction to that site. It does not enable Cloudflare-only access on
any site by itself.

The existing root-owned policy file stores `blockBypass`; a missing field means
true, including existing installations. An explicit false persists through
repair, update and addon reactivation. System Tweaks does not control this policy.

CloudPanel's broad real-IP trust can replace `$remote_addr` from a request
header before its access rules run. The extra check uses
[`$realip_remote_addr`](https://nginx.org/en/docs/http/ngx_http_realip_module.html#embedded_variables),
which retains the original connection address. Its lookup lives in the owned
HTTP-context file `/etc/nginx/sites-enabled/00-clp-addons-cloudflare-peer.conf`.
A marked block at the start of `/etc/nginx/cloudflare/ips` rejects peers outside
that lookup with 403. The rest of CloudPanel's include stays byte-for-byte
intact, so its existing address checks still apply too. The addon does not
change global real-IP trust, visitor-IP headers, logs or PHP's `REMOTE_ADDR`.

Ranges come from the trusted, root-owned CloudPanel include. Only numeric IPv4
and IPv6 `allow` rules followed by `deny all` are accepted; custom directives,
untrusted files, modified markers and an unrelated lookup file are refused.
An operator's access rule elsewhere remains in place; the page reports whether
this addon's check is configured, not whether every possible outside protection
exists. No local-network or loopback exemption is added. CloudPanel's normal
WordPress/Varnish backend has no Cloudflare include and is unaffected. A server
that puts that include in a backend must remove it there or leave this switch
off. Direct ACME requests are rejected too; validation must reach the site via
Cloudflare or use DNS. Unrestricted sites do not use the check.

The shared Nginx transaction writes both files, tests the complete configuration
and reloads once. Validation or reload failure restores both files and the
stored choice. Each Nginx command has a 30-second timeout; the gateway allows
180 seconds for validation/reload, possible rollback, the state reply and lock
waiting. Both limits are in `addons/cloudflare-ips/limits.ts`.

Activation, update, repair and `repair --anchors-only` apply the saved policy. The
existing path watcher watches the include and its directory, so a CloudPanel
range replacement refreshes the lookup and puts the block back. This is eventual
repair: a replacement loaded before the watcher finishes temporarily has only
CloudPanel's rules. The page reports missing or stale configuration as needing
repair, and watcher failures are logged. It reports configuration on disk,
not a probe of live Nginx workers. Disabling the switch or addon removes only
the exact marked block and owned lookup, preserving the current ranges rather
than restoring an old copy. Re-enabling the addon restores its saved choice.
The policy lock serializes protection changes with site and new-site policy
changes.

`bun tests/integration/integration-cloudflare-peer.ts` tests the generated
configuration with real Nginx in an isolated Docker network: rejection of
requests from untrusted peers, IPv4/IPv6 trusted peers, local backend proxying,
direct ACME requests and unrestricted sites.
