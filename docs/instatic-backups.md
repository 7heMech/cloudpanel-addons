# Back up and restore Instatic

CloudPanel Remote Backups include an Instatic site's uploads and its recovery
archive when the site's full home directory is included. Check any custom backup
exclusions before relying on this.

The files needed for recovery are:

| Content | Location |
| --- | --- |
| Uploads | `/home/<site-user>/htdocs/<domain>/uploads/` |
| Database, encryption key, and metadata | `/home/<site-user>/backups/databases/instatic-<domain>.tar.gz` |

## Existing sites

Sites created with CloudPanel Addons 1.1.3 or later use the backup-compatible
layout. Migrate a site created by an earlier release with:

```sh
clp-addons action instatic recreate --domain example.com
```

Updating the site's Instatic version also migrates it. The operation keeps the
existing data and encryption key and rolls back if the replacement fails its
health check.

## Schedule

Enabling Instatic creates `/etc/cron.d/clp-addons-instatic-backup` with a daily
03:30 schedule in the server's timezone. Set it to run before the site's
CloudPanel Remote Backup. Updates and repairs preserve a changed schedule.

Create recovery archives immediately with:

```sh
# All Instatic sites
clp-addons action instatic backup

# One site
clp-addons action instatic backup --domain example.com
```

The command returns a nonzero status if any requested backup fails. Check that
the archive timestamp is newer than the last successful run before restoring.

## Restore

1. Restore or create the CloudPanel reverse proxy site for the same domain and
   port. Install CloudPanel Addons with Instatic enabled and make sure Docker is
   running.
2. Restore the site's home directory, including its `uploads/` directory and
   recovery archive. Stop an existing Instatic container before replacing
   files.
3. Run as root:

   ```sh
   clp-addons action instatic recreate --domain example.com --from-backup
   ```

The command validates the archive, restores the database and key, fixes
ownership for the current site user, starts the recorded version, and runs a
health check. Uploads must already be present. On success, the command reports a
`previousData` directory when older local data was preserved; remove it after
you verify the restored site.
