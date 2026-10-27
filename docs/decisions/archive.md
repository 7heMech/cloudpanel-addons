# Archive Sites

## Archiving

Archiving a site takes a final backup and then deletes the site, in that order
and in one job. It starts from the live site because DNS's Remove records and
Keep only appear once CloudPanel has already deleted a site, when there is
nothing left to back up.

For each site, every CloudPanel database is exported with `clpctl db:export`,
the site user's whole home is packed with `tar`, and both are read back
(`gzip -t`, `tar -t`) before anything is deleted; a file that changed while it
was read is not a failure. The panel's record of the site goes into the
archive's `meta.json`: type, application, PHP, Node.js or Python version, app
port, reverse proxy URL, site user, root directory, the stored vhost body, the
databases and their users, and for reference its SSH and FTP users and cron
jobs. Then `clpctl site:delete` removes the site, and any of its databases the
panel kept. A backup that fails deletes nothing and leaves no archive behind.
Sites are archived one after another; one that fails does not stop the rest.

A database user's password is never read. The panel's own encrypted copy of it,
and MySQL's hash from `mysql.user` for each host, read with the panel's master
credentials passed to `mysql` only in the environment, are kept instead.

Instatic's sites are left to Instatic, whose own delete keeps a final archive
of its data. DNS's stand-in sites are not sites, and are not listed.

## Restoring

Restoring creates the site again with the panel's own command for its type, the
same PHP version and site user, and a new site user password, since the old one
cannot be read; a PHP site whose vhost template no longer exists is created as
a generic one. The home is unpacked as the site user, with no owner taken from
the archive. Each database is created again with `clpctl db:add` and imported,
and its first user's MySQL hash and panel copy are set back, so the
application's configuration still connects. The stored vhost body is written
again through `cli/site-vhost.ts`, moving the root directory with it. Other
database users, SSH and FTP users and cron jobs have no `clpctl` command; the
job's result names them to add again. The archive is kept and marked restored.

A restore is refused while CloudPanel has a site of that name, or while DNS has
a redirect for the domain, whose rule would keep sending its visitors away.

## Redirecting

When DNS is enabled, a site can be made a redirect domain once it is deleted.
The archive job calls DNS's `archive-redirect` in-process; see
[DNS](dns.md#archived-sites). Its zone and mail records stay.

## Surfaces and state

The addon page lists CloudPanel's sites with search and bulk selection, and the
archives with Restore and Delete. Archive, restore and delete each run as one
background job at a time, followed with the shared job progress bar, since a
site's files can take minutes. A Sites row has an Archive link in its action
menu only, before Manage, as Stager's Clone is: archiving is rare, and the link
opens the addon page with the site picked rather than archiving anything.

Archives are `/var/backups/clp-addons/archive/<domain>--<time>/`, a root-only
directory of mode 0700 holding `meta.json`, `home.tar.gz` and a
`db-<name>.sql.gz` per database, each 0600. They are kept until deleted from
the page, which asks for the domain to be typed.
