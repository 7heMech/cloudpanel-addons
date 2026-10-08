# Resource Guard

## Scope and ownership

Resource Guard contains ordinary ImageMagick temporary cache writes and reports
disk pressure. PHP Resources continues to own FPM categories and its nine pool
directives. Resource Guard neither changes request timeouts nor promises CPU,
memory, site-home or database quotas. Site-user quotas do not account for
database files owned by MariaDB. This addon is administrator-only.

ImageMagick's `resource:disk` limit accounts for a process's current pixel caches.
It does not account for concurrent processes together or files abandoned by dead
processes. Hundreds of individually permitted cache files can exhaust the root
filesystem. A shorter FPM timeout can interrupt cleanup; that possibility is not
proof that a particular timeout, memory limit or addon caused an incident.

## Disk containment

Protection is off until an administrator saves it on. Installation provides
monitoring without allocating storage or reloading PHP. The default shared
budget is 2,048 MiB; initial allocation accepts 256–16,384 MiB. An existing image
cannot be resized in place. Allocation must leave at least 2 GiB and 10% of the
backing filesystem free, whichever is larger.

`/var/lib/clp-addons/resource-guard/scratch.img` is a root-owned, fully
preallocated regular file formatted as ext4 with no reserved blocks.
`mkfs.ext4` uses `nodiscard` so formatting does not punch holes in that file.
The filesystem mounts at `/var/cache/clpaddons/imagemagick`, with
`loop,nodev,nosuid,noexec`. This introduces an aggregate disk boundary without
changing the root filesystem's quota features, partition layout or `/tmp`.
It consumes disk space, rather than a large tmpfs allocation of RAM/swap.
Filesystem metadata is part of the allocated budget, so usable cache capacity
is slightly smaller than the image size.

The standalone `var-cache-clpaddons-imagemagick.mount` unit mounts during normal
boot. The directory underneath is root-only and empty; its mounted filesystem
root is root-owned mode `1777`. Site processes cannot write through to the
backing filesystem when the mount is absent. Root processes are outside that
permission boundary. The mount's loop device, backing file, filesystem type and
options are checked before reporting protection or running scratch cleanup.

Only `/etc/ImageMagick-6/policy.xml` and `/etc/ImageMagick-7/policy.xml` are
supported. A marked block at the end of `policymap` sets `resource:temporary-path`
and `cache:synchronize`. All existing memory, map, disk and coder policies are
preserved. Synchronization asks ImageMagick to report allocation failure before
later writes through a memory mapping can encounter an unbacked page.

Site PHP services are gracefully reloaded after policy changes. Protection is
verified with every versioned PHP CLI found under `/usr/bin` that loads Imagick:
an unprivileged `nobody` process forces a small pixel cache onto disk and checks
its own descriptors and mappings for the managed path. The CLI verification does
not certify separately configured FPM extension libraries or long-running CLI
jobs; an application using a different ImageMagick build/configuration remains
outside the verified scope. The page labels these results as verification at
the last apply. Existing long-running workers may finish using their old policy
during a graceful reload. Unknown installations are refused rather than assumed
protected.

Policy writes preserve ownership and mode and use atomic replacement. A
verification, reload or settings-write failure restores the changed policy
files and reloads PHP again. The allocated image can remain after a failed first
apply; it is kept for retry rather than deleting a filesystem that another
process could already hold. Files, state and their parent paths must be trusted,
with no symlinks or site-writable ancestors.

## Cleanup

Only regular, single-link files whose names match `magick-[A-Za-z0-9_-]+` are
eligible. Cleanup is nonrecursive and reads no file contents. The newest of
atime, mtime and ctime must be older than the saved retention, at least 24 hours.
Cleanup scans process descriptors and `/proc/<pid>/maps` by device/inode, so an
active memory mapping is retained even after its descriptor closes. Any
permission or inspection failure skips cleanup; disappearing processes are
allowed. Process and descriptor scans are bounded, with a 15-second process
scan budget. File inventories scan at most 10,000 entries and identify partial
counts. Ownership totals use allocated blocks, not logical file length.

The unlink path opens with `O_NOFOLLOW|O_NONBLOCK` and rechecks type, link count,
device/inode, size and modification/change times. It never follows a symlink,
recurses into a directory, or writes into an existing file. These checks are
conservative housekeeping for ordinary image jobs, not a sandbox against a
process deliberately racing the cleaner or retaining a pathname without an
open reference. The filesystem boundary still limits aggregate scratch storage
when cleanup skips files.

Legacy `/tmp` cleanup is separately opt-in and uses the same rules only on
direct children of its root-owned sticky directory. PrivateTmp subdirectories,
sessions, arbitrary uploads and `/var/tmp` are not swept. Existing files are not
moved into scratch storage. A filename and Unix owner identify candidates, not
which WordPress plugin created them.

## Monitoring and lifecycle

`clp-addons-resource-guard.timer` runs the root `check` action one minute after
boot and every five minutes after a check completes. It does not depend on the
manager, CloudPanel authentication, Redis or MariaDB. Warnings go to its journal
and the page; no external notification is sent. `check` does not require a write
to the root filesystem for its report: last-check/cleanup data lives in the
root-only `/run/clp-addons-resource-guard` directory and disappears at reboot.
The existing root lock directory serializes actions. Configuration remains
root-owned mode `0600` under addon state.

Monitoring groups `/`, `/tmp`, `/var/tmp`, addon state, the panel session path,
MariaDB and Redis data paths by filesystem device. Missing paths are omitted;
inspection errors are reported. Low unprivileged free bytes, free percentage or
free inode percentage produces a warning. At zero capacity, or 2% remaining
blocks/inodes, the level is critical. The scratch filesystem uses percentage
thresholds without the host's absolute minimum-free threshold.

Repair re-mounts saved protection, restores managed policy drift and verifies
PHP. It rearms a stopped timer. Disabling/uninstalling restores ImageMagick
policy and reloads PHP before a normal unmount; a busy unmount aborts withdrawal
and restores the managed policy. No lazy/forced unmount is used. Only then can
uninstall purge the image. Disabling keeps saved settings and the image for
reenabling. The guard service is conditioned on the enabled-addon file.
The gateway exposes only `status`, `configure` and `clean`; maintenance and
lifecycle verbs are root CLI operations.

Redis persistence settings, authentication, database repair, log retention and
files outside managed image scratch storage are not changed. The guard reduces
this failure's blast radius; it does not guarantee that arbitrary site code,
backups or logs cannot consume the rest of a shared root filesystem.

## References

- [ImageMagick cache resource accounting](https://imagemagick.org/architecture/)
- [ImageMagick policies and cache synchronization](https://imagemagick.org/security-policy/)
- [ImageMagick 6 temporary-path policy implementation](https://github.com/ImageMagick/ImageMagick6/blob/6.9.11-60/magick/resource.c)
- [FPM timeout and worker settings](https://www.php.net/manual/en/install.fpm.configuration.php)
