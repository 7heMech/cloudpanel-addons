# Maintenance Mode

## Panel surfaces

Maintenance Mode is available from the Addons overview and from an
administrator-only tab in every CloudPanel site view. The overview reads the
live CloudPanel site inventory and shows each site's effective status, saved
setting, template choice, and bypass count.

The global override is a card of its own labelled "Global maintenance", not a
switch in the table header: it decides what visitors get for every site at once
and changes nothing a site has saved. Its confirmation names the site count and
how many have maintenance saved off. While it is on, every site serves 503 and a
site whose own setting is off, or could not be read, shows a "Maintenance
(Global)" badge and is counted as in maintenance; turning it off returns each
site to its saved setting. Turning it on or off purges Varnish
cache across the fleet.

A domain query opens the focused editor for that site. That page is drawn in the
shell's site mode, so CloudPanel's site information and site tabs stay above it
and Settings remains one click away; it says explicitly when the global override
is what is serving the maintenance page, because changing the saved setting
there does not lift it.

## Request handling

The addon installs one marked block in `/etc/nginx/global_settings`, which all
customer site templates include. Nginx checks
`/var/lib/clp-addons/maintenance/_global/on` and
`/var/lib/clp-addons/maintenance/$server_name/on` on every request and clears
the maintenance decision when a matching `bypass_$remote_addr` file exists.
CloudPanel writes the database domain first in `server_name`, so aliases share
the canonical site's state and template. Turning a site on or off is an atomic
file operation and needs no Nginx reload.

The check returns an internal 418 sentinel and maps only that sentinel to the
public 503 maintenance response. An application's own 503 response therefore
keeps its own error handling. `/.well-known/acme-challenge/` is exempted before
the return so certificate issuance and renewal remain available.

The internal maintenance location serves a site's `maintenance.html` when present
and otherwise serves the managed `default.html`. Responses include
`Retry-After: 300`, disable caching, and apply a content security policy that
blocks scripts, forms, frames, and cross-origin assets.

## State and privileges

Only the root gateway changes maintenance state. It accepts a fixed verb set,
normalizes domains and IP addresses, checks that the domain is a current
CloudPanel site, and bounds a custom template at 256 KiB. Bypass updates replace
the complete list and allow at most 64 addresses.

The state root and per-domain directories are mode `0711`, which lets Nginx
traverse a known path without listing domains or bypasses. Toggle and bypass
files are mode `0600`; public HTML files are mode `0644`. Disabling or
uninstalling the addon removes the global Nginx block and keeps site state
unless purge was requested.

## Reconciliation

The global-settings reconciler records the pristine file and its SHA-256 hash.
It renders only when the current unmarked content still matches that baseline,
runs `nginx -t`, reloads the distro Nginx service, and restores the prior file
on validation or reload failure. Repair and the path watcher reconcile this
block alongside Twig and the CloudPanel manager proxy.
