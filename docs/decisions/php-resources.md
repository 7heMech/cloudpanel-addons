# PHP Resources

## Scope

CloudPanel writes one PHP-FPM pool file per PHP site from a template with fixed
numbers — `pm = ondemand`, `pm.max_children = 250`, `pm.max_requests = 100`,
`request_terminate_timeout = 7200s` — and offers no way to change them. Its own
PHP Settings form writes `memory_limit` and the other `php.ini` values into the
site's Nginx vhost as `PHP_VALUE` and never touches the pool. The pool file is
therefore the only file this addon writes, and the `php.ini` side stays with
CloudPanel's Settings tab.

The addon owns nine directives: `pm`, `pm.max_children`, `pm.start_servers`,
`pm.min_spare_servers`, `pm.max_spare_servers`, `pm.process_idle_timeout`,
`pm.max_requests`, `request_terminate_timeout` and `rlimit_files`. The pool's
identity — `[name]`, `listen`, `user`, `group`, `listen.allowed_clients` — is
CloudPanel's, which reads its own pool files back to allocate the next site's
port, so changing any of it would make the panel and the running pool disagree
about the same site.

## Panel surfaces

The overview at `/addons/php-resources/` lists every site CloudPanel recorded
PHP settings for, with the values its pool file holds now and whether they are
this addon's, CloudPanel's, or have drifted from what was saved.

Each PHP site also gets an administrator-only **Resources** tab, between
Maintenance and Staging. The injected Twig adds it only when `site.type` is
`php`, because a static or Node.js site has no pool file; `lib/site-context`
carries the same condition so the reproduced tab strip matches the panel's.

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
parse, keeps the old one, and reports success to systemd all the same. A failed
test restores the previous file and reloads the version again, so what is on
disk and what is running never disagree.

Combinations php-fpm would refuse to start on — spare-server bounds that cross,
a value outside its range — are refused before anything is written.

## Defaults and reconciliation

A default profile applies to sites created after it was set. The site ids that
exist when it is saved are recorded, so the default never reaches back over a
fleet that did not ask for it; turning it off leaves every site that already has
it alone.

Reconciliation runs as the addon's `repair` upkeep, which the reconcile timer
fires every fifteen minutes. It gives new sites the default and rewrites a
managed site whose pool file no longer matches what was saved. The second half
is not housekeeping: changing a site's PHP version in the panel deletes its pool
file and writes a stock one under the new version, so a tuned site silently
returns to 250 max children the moment somebody moves it from 8.2 to 8.3. A
profile for a site CloudPanel no longer has is dropped in the same pass.

No timer of its own: nothing here is urgent enough to justify one, and a new
site runs on CloudPanel's values in the meantime, which is what it would have
run on anyway.

## State and privileges

Only the root gateway changes a pool. It accepts a fixed verb set, normalizes
the domain, refuses the panel's own hostname and aliases, and requires the site
to have PHP settings in CloudPanel's database. `reconcile` is deliberately not
a gateway verb: it walks the whole fleet and belongs to repair.

Saved profiles live in `/var/lib/clp-addons/php-resources/policy.json`, mode
`0600` and root-owned; a policy file that is not a trusted regular file is
refused rather than read. A pool file is checked the same way before it is
written, and is replaced atomically with its mode and ownership preserved.
