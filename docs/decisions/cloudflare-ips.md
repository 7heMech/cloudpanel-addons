# Cloudflare IP Access

## CloudPanel state

The addon manages CloudPanel's existing `allow_traffic_from_cloudflare_only`
site setting. Enabling it updates the site row, changes the rendered access log
from `main` to `cloudflare`, and adds
`include /etc/nginx/cloudflare/ips;` to that site's Nginx vhost. Disabling it
reverses those rendered-vhost changes. CloudPanel remains the source of the IP
ranges in `/etc/nginx/cloudflare/ips`.

Bulk changes take one exclusive addon lock and one immediate SQLite transaction.
Every affected vhost must be a trusted regular file. The action stages all
changes, runs `nginx -t`, reloads Nginx once, and commits the database only when
the reload succeeds. On failure it rolls back the database and restores the
original vhosts. If any recovery step fails, the action attempts the remaining
steps and reports each failure with the original operation error.

## Dashboard

"Enable all sites" and "Disable all sites" are one-time changes to the sites
that exist now, sent as a single bulk request. Their confirmation names the
scope, how many sites change setting, and how many automatic exceptions the
request rewrites; an operation that would change neither is reported and not
sent. Nothing is restored afterwards, so the dialog says so rather than offering
an undo the action does not implement.

Selection checkboxes stay separate from the per-site switch, and the
selected-scope actions are unavailable until something is selected. A per-site
switch acts immediately without confirmation, because turning one site off is
the ordinary correction after a fleet-wide change. On a phone that switch stays
in the site's summary row. The full-size site-type badge follows the hostname's
final rendered line instead of occupying a narrow column. The switch is the
dashboard's only per-site action, so the mobile card does not spend a second
line repeating the desktop column heading.

After any change the page repaints from a fresh read rather than from what was
requested, keeping selection and scroll, and does the same after a failure so
the displayed state is the server's. A changed site inventory reloads instead.
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
