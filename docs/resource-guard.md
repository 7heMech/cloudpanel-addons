# Resource Guard

Enable the addon with `clp-addons install resource-guard`, then open **Addons →
Resource Guard**. It starts monitoring without changing image processing.

## Protect image scratch storage

Set **Image scratch protection** to **On**, choose the shared scratch budget,
and save. The default is 2 GiB. Save reserves that space on disk, configures
ImageMagick to use it, reloads site PHP services, and verifies PHP Imagick can
use the bounded filesystem. Existing ImageMagick disk and format restrictions
stay in place. A server must have at least 2 GiB and 10% free after allocation.

The budget covers all sites together. Once it is full, image processing may
fail while MariaDB, Redis and panel session storage remain on their existing
filesystems. Choose a budget that accommodates concurrent large image jobs.
Files still in use are not cleaned. Interrupted jobs can therefore exhaust a
small scratch disk until their abandoned files become eligible for cleanup.

Changing an allocated budget requires turning protection off and uninstalling
Resource Guard with `--yes --purge`, then reinstalling it and choosing the new
budget. Uninstall keeps data without `--purge`. If it was the last addon,
uninstall also removes `clp-addons`; reinstall through the README installation
procedure. Do not truncate or remove a mounted scratch image.

## Cleanup and warnings

Disk and inode checks run independently every five minutes. Warnings appear on
the page and in the system journal. Configure minimum free MiB, free percentage
and free inode percentage to suit the host. Any threshold can trigger a warning;
these are alerts, not filesystem quotas.

The default orphan retention is 24 hours. Only old `magick-*` regular files with
no open descriptors or memory mappings are eligible. **Clean eligible files**
runs the same cleanup immediately. Files inspected unsuccessfully are retained.

For preexisting orphan files in `/tmp`, change **Existing /tmp image files** from
**Report only** to **Clean eligible magick-* files**. This is optional and only
checks direct children of `/tmp`. It leaves sessions, uploads with other names,
other temporary files and private service directories alone. It does not reclaim
young files just because the disk is full.

If turning protection off or uninstalling reports a busy scratch disk, allow
image jobs to finish and retry. Long-running command-line jobs may still use
the old policy. Do not force or lazily unmount it.

## Check without panel login

SSH or the provider's recovery console can run these as root:

```bash
clp-addons action resource-guard status
clp-addons action resource-guard check
systemctl status clp-addons-resource-guard.timer
journalctl -u clp-addons-resource-guard.service --since '1 hour ago'
df -h / /tmp /var/cache/clpaddons/imagemagick
df -i / /tmp /var/cache/clpaddons/imagemagick
```

The `status` command returns live filesystem capacity, image-file ownership and
allocation, policy readiness, and the last cleanup result as JSON. `check` also
runs saved cleanup rules and records its result. Runtime results are stored in
`/run`, so reporting remains possible when the root disk is full; a reboot
clears that last-check report. Core commands still require a functioning host.

To restore missing policies or the mount, use:

```bash
clp-addons repair resource-guard
```

## Diagnose disk exhaustion

Check both bytes and inodes, then determine which filesystem and directory
grew. `du` reports allocated space; `ls -lh` can overstate sparse-file usage.
A deleted file held open by a process still consumes space until it is closed.
Large `/tmp/magick-*` files identify image-processing scratch, but their owner,
timestamps and logs are needed to identify which application/job created them.

The existing ImageMagick `disk="1GiB"` policy limits a process's current pixel
caches. It does not limit abandoned files or the combined usage of multiple
processes. Confirm the policy and library actually used by the affected PHP
version; a shell `identify` command can use a different build and may not be
installed at all.

For a possible PHP Resources contribution, compare file timestamps and owners
with FPM messages such as request execution timeout, worker termination,
segmentation faults and SIGBUS. Also check the kernel journal for OOM kills.
The category presets have a 300-second request termination timeout. A worker
termination can interrupt cleanup, but timing/configuration evidence is needed
to establish that it occurred. Ordinary worker recycling alone is not proof.

CloudPanel stores its login session files under
`/home/clp/htdocs/app/files/var/sessions`. If that filesystem is full, persisting
the state required for two-factor authentication can fail. Check the panel PHP
logs for the actual session/write error; a failed redirect alone does not
identify its cause. Diagnose SSH failures from its authentication logs separately.

After reclaiming space, verify Redis snapshot persistence (`rdb_last_bgsave_status`
in `INFO persistence`) and inspect Redis logs if writes remain refused. Keep
`stop-writes-on-bgsave-error` enabled rather than masking a persistence failure.
Check MariaDB logs and the affected table engines before selecting a recovery
procedure; `REPAIR TABLE` is not a general repair mechanism for InnoDB. Resource
Guard never restarts databases or repairs their tables automatically.

Disk containment protects ordinary ImageMagick scratch writes that use the
managed policy. Site files, databases, backups, logs, custom ImageMagick builds
and other temporary-file producers need their own storage budgets/retention.
The addon does not impose per-user CPU, memory or whole-home disk quotas.
