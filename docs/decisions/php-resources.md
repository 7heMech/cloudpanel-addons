# PHP Resources

## Scope

CloudPanel writes one PHP-FPM pool file per PHP site from a template with fixed
numbers — `pm = ondemand`, `pm.max_children = 250`, `pm.max_requests = 100`,
`request_terminate_timeout = 7200s` — and offers no way to change them. Its own
PHP Settings form writes `memory_limit` and the other `php.ini` values into the
site's Nginx vhost as `PHP_VALUE` and never touches the pool. The pool file is
therefore the only configuration this addon writes, and the `php.ini` side stays
with CloudPanel's Settings tab.

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

Everything is decided at `/addons/php-resources/`. The page opens with a drift
notice when there is drift, then the PHP sites, then the categories with the
choice of category for new sites in their header. The site table carries
selection and a bulk assignment, because moving forty sites is the ordinary
operation; from six sites it has a search and a Drifted filter. Each site shows
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
card is empty markup that fills itself from `/addons/php-resources/site-card`
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
writes a new site's vhost (see [Platform](platform.md#new-sites)), and as its
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

A PHP request stopped by `max_execution_time` or `request_terminate_timeout`
skips the cleanup that would remove its scratch files, and a CloudPanel box
empties `/tmp` only at boot. An image too large for ImageMagick's memory limit
is cached on disk, so a WordPress image job that keeps timing out leaves close
to a gigabyte in `/tmp` on every try, and has filled a production disk that way.

The same upkeep removes them. It reads only the top level of `/tmp`, never
follows a symlink, and removes a regular file only when a PHP site's own user
owns it, no process has it open or mapped, and it matches one of three names:
ImageMagick's `magick-*` after two idle hours, and PHP's `php??????` uploads and
WordPress's `wp_tempnam()` `*-??????.tmp` files after a day, since those are
closed between being written and being read. Running it before reconciliation
means a site that keeps failing to reconcile cannot stop it.

Cleanup inspects process file descriptors and memory maps before deleting any
file. A closed descriptor or a process that has exited can be skipped; an
inspection failure for a process whose directory still exists stops cleanup
and logs a warning. Unlink errors also reach that warning logger, except when
the file has already disappeared. Reconciliation still runs after a cleanup
failure.

## State and privileges

Only the root gateway changes a pool. It accepts a fixed verb set, normalizes
every domain, refuses the panel's own hostname and aliases, and requires each
site to have PHP settings in CloudPanel's database. `reconcile` is deliberately
not a gateway verb: it walks the whole fleet and belongs to repair.

Categories and assignments live in
`/var/lib/clp-addons/php-resources/policy.json`, mode `0600` and root-owned; a
policy file that is not a trusted regular file is refused rather than read. A
pool file is checked the same way before it is written, and is replaced
atomically with its mode and ownership preserved.
