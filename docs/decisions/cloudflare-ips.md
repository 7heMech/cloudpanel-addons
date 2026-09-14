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
