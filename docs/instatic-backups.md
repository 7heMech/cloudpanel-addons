# Instatic and CloudPanel Remote Backups

Instatic stores application files in the CloudPanel site user's home. CloudPanel
[Remote Backups](https://www.cloudpanel.io/docs/v2/admin-area/backups/) include the
whole site home by default, excluding `.ssh`, `logs`, and `tmp`. Application data
does not need to be inside the web root to be backed up. Custom exclusions can
change this coverage.

| File or directory | Location |
| --- | --- |
| Live SQLite database | `/home/<siteUser>/instatic/<domain>/data/instatic.db` |
| Encryption key and container environment | `/home/<siteUser>/instatic/<domain>/.instatic.env` |
| Uploads and media | `/home/<siteUser>/htdocs/<domain>/uploads/` |
| Authoritative instance metadata | `/var/lib/clp-addons/instatic/<domain>/meta.json` |
| Clean database, key, and metadata recovery archive | `/home/<siteUser>/backups/databases/instatic-<domain>.tar.gz` |

The container runs as the CloudPanel site's numeric UID/GID. `data/` and
`uploads/` belong to that account with mode `0750`. The env file belongs to
`root:<siteGroup>` with mode `0600`: only root reads the file; Docker passes its
values into the container. Recovery archives are root-owned, mode `0600`.
CloudPanel's Remote Backup archive command uses `sudo tar`, which can read these
files. Copying or extracting the recovery archive requires root access.

Stager continues to discover instances through the original `meta.json` path and
clone through Instatic's HTTP API. Uploads are available through the site's File
Manager and SFTP.

## Enable backups for an existing instance

New instances use this layout immediately. After installing an addon release
with this support, migrate each older instance:

```sh
clp-addons action instatic recreate --domain example.com
```

An image update also migrates legacy storage. Ordinary start/stop/restart keeps
the existing container's mounts. Migration stops the container, takes a recovery
snapshot, copies the data and original key, and checks the replacement's health.
The original data is removed only after the replacement succeeds. Failed starts
restore the previous container. Conflicting destination files or symlinked
storage paths stop the operation without overwriting those paths.

Legacy instances are reported as failures by the native backup command until
migrated; their existing manual Snapshot command remains available. The command
continues backing up other instances when one fails. Use the CLI for migrations
with large uploads that may exceed the manager's five-minute request timeout.

## Scheduling and consistency

Installation and repair install `/etc/cron.d/clp-addons-instatic-backup`, initially
scheduled for **03:30 in the server's timezone**. Edit its schedule to run before
your configured Remote Backup job; repair preserves that edit. Disabling or
uninstalling Instatic removes the cron entry.

**03:30 is a schedule, not a CloudPanel pre-backup hook.** In the CloudPanel
2.5.4-2 package, `/home/clp/scripts/create_backup.sh` at 04:15 backs up the panel
application and its database. Site Remote Backups are separate. Changing that
panel job does not establish ordering for site backups.

Take a fresh recovery snapshot before a manual Remote Backup:

```sh
# Every migrated instance; nonzero exit status if any backup fails.
clp-addons action instatic backup

# One instance.
clp-addons action instatic backup --domain example.com
```

The snapshot opens SQLite through Bun's native driver and uses SQLite's
consistency-preserving `VACUUM INTO` operation, including committed WAL
transactions. It checks the result as a read-only database and packages the
standalone copy with the key and metadata, then renames the completed archive
into place on the same filesystem. Instatic does not require the `sqlite3`
executable for backups. Failure preserves the previous complete archive. It
takes the same per-domain operation lock as update/recreate/delete, and does
not stop the live container. SQLite can take short read locks; this is not a
zero-lock guarantee.

The recovery archive omits uploads because CloudPanel already captures them
from `htdocs`. Its database reflects the snapshot time; uploads reflect the
later Remote Backup time. This is not a single point-in-time snapshot of both
the database and media. A scheduled snapshot can be stale if it failed or the
Remote Backup ran first. Check command failures and the archive's modification
time. An application-wide point-in-time backup requires quiescing writes while
capturing both parts.

## Restore a CloudPanel backup

1. Restore or create the CloudPanel reverse-proxy site for the same domain and
   recorded loopback port. Install/enable the Instatic addon and Docker on the
   destination server. The recovery archive's `meta.json` records its version
   and port; root can inspect it with `tar -xOzf <archive> ./meta.json`.
2. Stop any existing Instatic container **before replacing files from the site
   backup**. Restore the site's home files, including `htdocs/<domain>/uploads`
   and `backups/databases/instatic-<domain>.tar.gz`, under the current site user.
   Follow CloudPanel's file-restoration procedure; its archive preserves the
   home-directory layout and is not simply an archive of `htdocs`.
3. As root, run:

   ```sh
   clp-addons action instatic recreate --domain example.com --from-backup
   ```

This explicit recovery command validates the archive's domain, version, port,
key, expected Instatic schema, and database before replacing data. It restores
the clean database instead of trusting a file copy of the live SQLite/WAL
files, removes stale sidecars,
rebuilds missing `/var/lib` metadata, fixes ownership for the current site user,
pulls the recorded image, and checks the new container's health. Uploads must
already have been restored. A recovered metadata file does not grant permission
to delete an adopted CloudPanel site.

On successful recovery, any previous local data is kept in the `previousData`
directory reported by the command. Review and remove that directory when no
longer needed. A failed startup attempts to restore the previous local data and
container; if rollback itself fails, the command reports where recovery files
remain. An interrupted migration likewise retains its original data and
pre-migration snapshot; resolve any `-prev` container or incomplete destination
before retrying.

Ordinary `recreate` keeps live data and never substitutes a scheduled backup.
It refuses to generate a new encryption key for an existing instance with a
missing key. The original key is required to decrypt that instance's data.

The Snapshot button, update rollback, and final deletion archive continue to
include the database, key, metadata, and uploads. Their private local archives
remain under `/var/lib/clp-addons/instatic/<domain>/snapshots/` or
`/var/backups/clp-addons/instatic/`; the scheduled recovery archive is the one
placed in the site home for CloudPanel.
