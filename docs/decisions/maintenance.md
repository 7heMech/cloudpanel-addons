# Maintenance Mode

## Panel surfaces

Maintenance Mode is available from the Addons overview and from an
administrator-only tab in every CloudPanel site view. The overview reads the
live CloudPanel site inventory and shows each site's status, template choice,
and bypass count. A global toggle in the card header switches every available site into
or out of maintenance mode at once with confirmation naming the count, reflects aggregate fleet
state (checked, unchecked, or indeterminate), and reports partial failures while preserving row
states. A domain query opens the focused editor and links back to the
site's Settings page.

## Request handling

The addon installs one marked block in `/etc/nginx/global_settings`, which all
customer site templates include. Nginx checks
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
