# Instatic CMS

## Instance model

Each site is a CloudPanel reverse proxy backed by a Docker container bound to
`127.0.0.1`. The action accepts exact image versions and records the domain,
port, version, site user, and ownership of the CloudPanel site under
`/var/lib/clp-addons/instatic/`.

An existing CloudPanel site is adopted only when it is already a reverse proxy
to the requested local port. The panel hostname itself is always rejected.

## Storage and replacement

The live SQLite database and environment file are outside the document root at
`/home/<site-user>/instatic/<domain>/`; uploads stay under the site's `htdocs`
directory. This lets CloudPanel back up the complete application while keeping
private files out of the web root.

Update and recreate take a clean local snapshot before replacing the container.
The recorded data and encryption key are retained, and a failed health check
restores the previous version. User-created snapshots are a five-file rolling
window. Deletion writes a separate final archive and does not prune earlier
deletion archives.

## CloudPanel Remote Backups

A scheduled recovery archive combines a consistent SQLite copy, the encryption
key, and instance metadata. It is written atomically into the site user's home
so CloudPanel Remote Backups can capture it with uploads. Recovery is explicit
through `recreate --from-backup`; ordinary recreate always uses live data.

Database and uploads are captured at different times, so the Remote Backup is
not a single point-in-time application snapshot. See the operator steps in
[Back up and restore Instatic](../instatic-backups.md).
