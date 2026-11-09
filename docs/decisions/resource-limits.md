# Resource Limits

## Scope

CloudPanel writes one PHP-FPM pool file per PHP site from a template with fixed
numbers — `pm = ondemand`, `pm.max_children = 250`, `pm.max_requests = 100`,
`request_terminate_timeout = 7200s` — and offers no way to change them. Its own
PHP Settings form writes `memory_limit` and the other `php.ini` values into the
site's Nginx vhost as `PHP_VALUE` and never touches the pool. The pool file is
the PHP configuration this addon owns; `memory_limit` and `upload_max_filesize`
stay in CloudPanel’s PHP Settings tab. Server memory policy for MySQL, Redis and
OOM priorities belongs here because PHP workers share the same RAM. Enabled, it
turns OOM protection on and leaves service sizing off, and assigns no existing
PHP site to a category.

The addon owns nine directives: `pm`, `pm.max_children`, `pm.start_servers`,
`pm.min_spare_servers`, `pm.max_spare_servers`, `pm.process_idle_timeout`,
`pm.max_requests`, `request_terminate_timeout` and `rlimit_files`. The pool's
identity — `[name]`, `listen`, `user`, `group`, `listen.allowed_clients` — is
CloudPanel's, which reads its own pool files back to allocate the next site's
port, so changing any of it would make the panel and the running pool disagree
about the same site.

## Categories

Limits belong to a named category, not to a site. A site is put in one, and its
pool follows that category: editing the category rewrites every pool assigned to
it. A fleet is then tuned by deciding once what a busy site is, rather than by
opening one form per site — which is the whole reason the addon exists, since
one site at a time is what `nano` already offers.

A site in no category is left on whatever CloudPanel wrote. Taking one out of a
category restores the stock pool byte for byte, because leaving it on numbers
nothing claims would make every surface lie about what the box is running.

A server that has saved nothing already has three categories — Lite, Standard,
Pro — with per-site ceilings of 3, 8 and 12 workers. They are named as a plan
ladder rather than after traffic descriptions, so picking one reads like picking
a size. All three use a 200-request recycle limit. Lite and Standard use
`ondemand` with a ten-second idle timeout. Pro uses `dynamic` to avoid
process-start latency under sustained load, but starts only two workers and
retains one to three spares. A category is multiplied by every site assigned to
it, so the page states that multiplication explicitly and describes Pro as a
sparingly assigned profile. A new operator-created category starts from the Lite
profile rather than CloudPanel's 250-worker ceiling.

The presets are ordinary categories: editable, renamable, deletable. They are
produced on read rather than written at install, so a read never writes, and a
deleted preset stays deleted because by then the policy file exists and says
so. Once saved, categories are operator configuration and later releases do not
replace their limits silently.

## Panel surfaces

Everything is decided at `/addons/resource-limits/`. The page opens with Memory and its combined budget, then a drift
notice when there is drift, the PHP sites, and the categories with the
choice of category for new sites in their header. The site table carries
selection and a bulk assignment, because moving forty sites is the ordinary
operation; from six sites it has a search and filters for drifted, PHP
version and category, and its headings sort. Each site shows
its PHP version under its name. A site row selects as a whole with a
highlighted state and keyboard support. Desktop retains the conventional
checkbox; at 940px or narrower, where rows become cards, it is omitted and the
width goes to the site card. Category pickers remain independent controls and
never alter selection.

The category editor is a native modal dialog showing the name, process manager
and max children, which are what a category is chosen by; idle or spare
workers, recycling, request timeout, open files and the description sit under
More limits. Cancel, Escape, or a click on its backdrop dismisses it without
saving.

A site's Settings tab in CloudPanel shows a read-only card under the panel's own
PHP Settings form, with the category and a one-line summary of the workers the
site is running; every limit is behind an All limits toggle. Twig
cannot see either — they are in a pool file and in this addon's policy — so the
card is empty markup that fills itself from `/addons/resource-limits/site-card`
and stays hidden if it cannot. No site-scoped addon page and no extra tab: a
form there would promise that one site's limits can be changed on their own.

Successful mutations return dashboard HTML rendered from their returned state,
including partial write failures. The browser repaints in place, preserves site
selection, search and the bulk picker, closes the completed dialog and reports
the outcome with `notify`.
A refused change restores its category picker without replacing the view.

## Writing the pool file

A managed directive already in the file is rewritten where it stands, so the
file keeps CloudPanel's ordering. A directive the chosen process manager does
not read is removed, because php-fpm warns about `pm.start_servers` under
`ondemand` and that warning lands in the customer's error log. One that applies
and is missing is inserted beside the managed directives that are still there,
in the order a stock pool file has them. Rendering is settled: a second pass
over its own output changes nothing.

Every write is followed by `php-fpm<version> -t` and then
`systemctl reload php<version>-fpm`. The test is what makes a bad number
recoverable: a reload signals php-fpm, which refuses a configuration it cannot
parse, keeps the old one, and reports success to systemd all the same.

Files are written for a whole assignment before anything is reloaded, and each
PHP version is reloaded once however many sites it covered. The rollback is per
version for the same reason: `php-fpm -t` tests a version's entire
configuration, so a refusal is about every file written for it, and the files
written for that version are all put back and the version reloaded again.

Combinations php-fpm would refuse to start on — spare-server bounds that cross,
a value outside its range — are refused before anything is written.

## New sites and reconciliation

One category can be the one new sites join. The site ids that exist when it is
chosen are recorded, so it never reaches back over a fleet that did not ask for
it; assigning a site explicitly, including to no category, records its id too,
so a deliberate choice is not overwritten later.

Reconciliation runs as the addon's `newSites` hook, seconds after CloudPanel
saves a new site (see [Platform](platform.md#new-sites)), and as its
`repair` upkeep every fifteen minutes. It puts new sites in the default category
and rewrites an assigned site whose pool file no longer matches it. The second
half is not housekeeping: changing a site's PHP version in the panel deletes its
pool file and writes a stock one under the new version, so a tuned site silently
returns to 250 max children the moment somebody moves it from 8.2 to 8.3. The
addon page offers the same repair on demand, for an operator who does not want
to wait. An assignment for a site CloudPanel no longer has is dropped in the
same pass.

A pool matches its category when it holds the directives the category would
write, so numbers the chosen process manager never reads, such as spare servers
under `ondemand`, do not count as drift. A new site whose pool file could not be
written, such as one CloudPanel has not written yet, is not recorded as known,
so the next pass tries it again. A pass that changes nothing leaves the policy
file alone.

## Abandoned temp files

While System Tweaks is off, the upkeep also clears the temp files timed-out PHP
requests leave in `/tmp`, so a box with Resource Limits alone keeps that
cleanup, and a failed pass is only a warning. System Tweaks owns it; see
[System Tweaks](system-tweaks.md#abandoned-temp-files).

## State and privileges

Only the root gateway changes a pool. It accepts a fixed verb set, normalizes
every domain, refuses the panel's own hostname and aliases, and requires each
site to have PHP settings in CloudPanel's database. `reconcile` is deliberately
not a gateway verb: it walks the whole fleet and belongs to repair.

Categories and assignments live in
`/var/lib/clp-addons/resource-limits/policy.json`, mode `0600` and root-owned; a
policy file that is not a trusted regular file is refused rather than read. A
pool file is checked the same way before it is written, and is replaced
atomically with its mode and ownership preserved.

## Memory limits

CloudPanel sizes its services once, at install, the same on every server: a
512 MB InnoDB buffer pool, 512 connections with 8 MB sort and join buffers, a
16 MB `read_rnd_buffer_size` and 128 MB in-memory temporary tables, Redis with
no limit and `noeviction`, Varnish at 512 MB and Memcached at 64 MB. On a 4 GB
server MySQL's worst case alone is many times the RAM. Nothing sets an
out-of-memory priority, so when memory runs out the kernel kills the largest
process, which is MySQL, and every site loses its database.

### Policy saved, sizes derived

Settings hold a profile (`balanced`, `database` or `cache`) and three switches,
never a size. Choosing a profile does not enable a service's sizing switch.
With both sizing switches off, the page says Sizing off and retains the chosen
profile for previewing. The budget always assumes both sizing
switches are on; each service's row reports its own state. The Redis row calls
the cap On only when its switch is enabled and the live values match the
profile, so an operator's own matching limit does not look like an active
addon cap. Out-of-memory protection is independent of sizing.

The sizes come from `MemTotal` each time they are applied:

| Profile | Buffer pool | Connection budget | Redis |
| --- | --- | --- | --- |
| Balanced | 25% of RAM | 15% | 10% |
| Database-heavy | 40% | 20% | 5% |
| Cache-heavy | 15% | 10% | 20% |

A saved size would be wrong after the server is resized: unused RAM after
scaling up, and after scaling down a buffer pool bigger than the server, which
runs it out of memory at boot. Most providers resize by stopping the server, so
the sizes are worked out again when the services start:

- MySQL's unit gets `ExecStartPre=-+clp-addons sync-memory mysql`, which
  rewrites `zz-clp-addons-memory.cnf` before mysqld reads its options. `+` runs
  it as root under the unit's `User=mysql`; `-` means a failure starts MySQL on
  the last file instead of not at all.
- Redis's unit gets `ExecStartPost=-+clp-addons sync-memory redis`, which sets
  the cap once the server is ready.
- Repair, every 15 minutes, catches a resize without a reboot. Redis takes the
  new cap at once; MySQL's file changes and the page says it applies at the
  next restart.

Both hooks read the policy without the memory settings lock, which a change
holds for up to two minutes. A change saves before it applies, so after
applying, a hook reads the policy again and applies it once more if it moved:
an Off change that lands meanwhile wins. No memory change waits for MySQL or
Redis to start or stop.

A change from the page has one 120-second deadline for itself and, when a step
fails, for putting the previous settings back; each command gets what is left
of it, at most its usual 30 seconds. One change is a few seconds when nothing
hangs. `set-memory` answers with the saved settings only, and the page the
browser repaints comes from a separate `list` request, bounded as loading the
page is. The gateway's timeout for `set-memory` is the deadline, the 15-second
settings lock wait, the waits on `memory.json`'s lock, and the reply.
The MySQL switch names the save and validation in its progress message and
says on success that the sizes apply at the next restart; it does not report
the running server as resized just because the file was saved.

### MySQL

The option file is read after CloudPanel's `mysqld.cnf`, in the same directory
as the [loopback file](system-tweaks.md#database-exposure), and overrides CloudPanel’s sizing defaults. It sets the
buffer pool, one instance per GB up to 8 (MySQL itself uses one below 1 GB), and
rounds the pool down to whole 128 MB chunks per instance, since InnoDB rounds a
size up to them. `max_connections` is the connection budget divided by 8 MB,
between 100 and 512, with the per-connection buffers lowered to 2 MB sort and
join and 1 MB read and read-rnd so that 8 MB holds. In-memory temporary tables
are capped at 32 MB each, and on MySQL 8 at 5% of RAM together
(`temptable_max_ram`, between 64 MB and 1 GB). Options MariaDB does not know
carry `loose-`, so it warns and starts.

Changing a setting never restarts MySQL. The file applies at its next start,
and the page shows Pending while the file is newer than the running server's
`ExecMainStartTimestamp`, read with `TZ=UTC` rather than `--timestamp=unix`,
which needs systemd 251 and Ubuntu 22.04 has 249. Restarting would take every site's database away for
a few seconds on a switch, and nothing here is urgent enough for that. Pending
offers **Restart MySQL** instead, behind a confirmation that says so:
`restart-mysql` runs `systemctl restart` on a running server under the
settings lock, so it never lands inside a change, and only while the file is
still pending, so a second tab's button does not restart it again. It fails
naming `journalctl` if the unit is not active afterwards, and the page is drawn
again either way. A stopped server is left stopped. The restart applies any
other pending MySQL configuration too, such as System Tweaks' loopback file,
which the confirmation says. Disabling the addon waits for a restart as long
as it holds the lock. Only the service restarts: a memory change does not touch MariaDB's
activation socket, whose listeners System Tweaks restarts with it. The
dynamic `SET GLOBAL innodb_buffer_pool_size` is not used either: it needs a
login, and Resource Limits does not decrypt the root password the panel stores
(see [Database exposure](system-tweaks.md#database-exposure)).

When the file changes, `mysqld --verbose --help` reads back the buffer pool and
`max_connections` it would start with. A later file or a startup option that
overrides them refuses the change and puts the previous file back, so the next
restart is not quietly ignoring the setting. A file of that name without the
marker belongs to someone else and is refused, as the loopback one is.

### Redis

Redis is capped with `CONFIG SET maxmemory` and `maxmemory-policy allkeys-lru`,
never `CONFIG REWRITE`: `redis.conf` is a conffile of the `redis-server`
package, and an edited conffile makes the next package upgrade stop at a prompt,
which unattended-upgrades handles by skipping the package, so Redis's security
updates would stop. Debian's `redis.conf` has no include directory, and an
`ExecStart=` override would have to copy the package's command line, so the
start hook is the remaining place. Switching off sets both back to what
`redis.conf` says, or Redis's defaults where it says nothing, but only when the
running Redis holds a cap Resource Limits set: `memory.json` in its state
directory records that, and a Redis restart, which drops it, clears the record.
The page, repair and Redis's start hook all rewrite that file, so each holds
its own lock while it reads and rewrites it, and none loses the other's field.
With the switch off and no such record, repair does not even read Redis's
settings, so values an operator set with `CONFIG SET` stay.

`allkeys-lru` suits a cache, which is what sites on CloudPanel use Redis for.
A site that keeps a job queue or other data it cannot lose in Redis would lose
keys at the cap, so the switch is off by default and its description says so.
A `redis.conf` with `requirepass` is left alone and the page says why; reading
the password to pass it to `redis-cli` would put it on a command line.

### The out-of-memory killer

`OOMScoreAdjust=` drop-ins give MySQL -600, nginx -500 and every site PHP-FPM
unit +300. When memory runs out the kernel then kills a PHP worker, which fails
one request and is replaced by its master, before MySQL or nginx, either of
which takes every site down. The panel's own PHP-FPM, Redis, Varnish and
Memcached keep the default. A unit's processes keep the score they started
with, so the processes in each unit's cgroup get the new value at once; switching
off writes back the score systemd shows for the unit without the drop-in. It is
on by default: it changes nothing until memory runs out, and then only which
process goes. A PHP version installed later gets its drop-in at the next repair.

No unit gets `MemoryMax=`. A cgroup limit makes the kernel kill inside the
service when it is reached, which is the outcome this avoids; the services' own
limits and the kill order do the job.

### The budget

One bar is the server's RAM. It holds MySQL (buffer pool, connection budget and
in-memory temporary tables), Redis's cap, Varnish's `-s malloc` size and
Memcached's `-m` from `/etc/memcached.conf`, then PHP's worst case: each pool's
current `pm.max_children` × the `memory_limit` in CloudPanel's `php_settings`
row. It uses the current pool, including drift, rather than the category repair
will apply. When PHP does not fit, its part runs off the end and the line below
says by how much and what to change: sites in no category or drifted back to
CloudPanel's 250 workers first, otherwise the category taking the most. A site
with an unreadable or unlimited (`-1`) `memory_limit` is not counted, and the
line says so rather than calling it a fit.

This is a planning estimate of simultaneous request limits, not RSS or an
enforced process-memory ceiling. MySQL and Redis are counted at profile sizes
even while their switches are off, since their current allowances are not known
without querying the services.

## Renamed from PHP Resources

An update moves a `php-resources` policy and enabled record to
`resource-limits`; a disabled install keeps its categories without being
enabled. Old URL paths redirect, with their suffix, query and method, after the
admin gate, so a site Settings card loaded before the panel reloads still works.
No old config, state directory or lock is kept. A PHP Resources change the
earlier version is still applying would write its old policy back, so an update
or install waits up to five minutes for it, and a repair leaves the move to the
next repair.

Memory settings saved in System Tweaks move to Resource Limits' own files. An
enabled System Tweaks with a memory protection on enables Resource Limits to
keep it; the switches of a disabled one stay off. Settings that are invalid or
differ from Resource Limits' own are dropped from System Tweaks with one warning
naming them, and Resource Limits keeps its own. Conflicting settings never stop
an update or a repair, and when there is nothing to move it takes no lock. A
lock still held after its wait skips the move in a repair, which tries again
next time, and fails an update, which then undoes the move for the binary it
restores.

Memory settings and runtime state are root-only regular files. The settings
lock serialises changes and upkeep; repair and new-site runs leave the memory
step to a change that holds it. Service start hooks read without the lock and
check the enabled config, so disabling the addon cannot recreate withdrawn
limits. Withdrawing waits as long as a change can hold the lock, since once the
enabled config is gone nothing would retry it. Disabling keeps PHP's saved
policy and current pools, withdraws memory sizing and OOM overrides, and leaves
MySQL's running sizes until its next restart.
