# Platform integration

## One manager process

The compiled `clp-addons` binary contains the CLI, manager, and all addon code.
`clp-addons serve` runs as the locked `clp-addons` account and serves enabled
addons from `/run/clp-addons/manager.sock`. A config file under
`/etc/clp-addons/` enables an addon; disabling it keeps the addon's state.

CloudPanel's master Nginx vhost proxies `/addons/` to the manager socket. The
manager uses the existing `cloudpanel` session and does not create a separate
site, hostname, or login.

## Managed CloudPanel changes

Nginx and Twig changes are marked and regenerated from a saved pristine copy.
Before changing Nginx, the reconciler validates the complete configuration and
restores the original vhost if validation or reload fails. If CloudPanel changes
the surrounding file, reconciliation stops instead of applying a patch against
unknown markup.

A path unit repairs managed blocks after CloudPanel rewrites watched files. A
15-minute timer repairs service, socket, permissions, and integration drift.
CloudPanel's legacy distro Nginx layout and its separate panel Nginx layout are
detected from their files and services rather than a version string.

## Live panel data

The manager requests current site and port information from the root gateway.
The gateway reads a consistent copy of CloudPanel's SQLite database and adds
ports recorded by addons or active listeners. Only domain, site user, site type,
and allocated ports cross the socket; no panel database snapshot is stored on
disk.
