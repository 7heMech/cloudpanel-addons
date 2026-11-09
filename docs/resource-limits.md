# Resource Limits

Open **Addons → Resource Limits** for PHP worker categories and the server's
memory budget. Existing PHP Resources categories and saved System Tweaks memory
choices move here automatically on upgrade.

## PHP workers

Select sites and assign a category, or edit a category to change all its sites.
Lite, Standard and Pro start at 3, 8 and 12 workers per site; adjust them for your
applications. Choose a default category for future sites in the Categories header.
Existing sites stay where they are until you assign them.

PHP's `memory_limit` and `upload_max_filesize` stay in CloudPanel's PHP Settings
tab. Each site's Settings tab also shows its current worker category and limits.

## Memory

The **Memory** card in Resource Limits sizes MySQL and Redis from the server's RAM, and decides
what the kernel kills first when memory runs out.

1. Choose a **Memory profile**: **Balanced**, **Database-heavy** or
   **Cache-heavy**. This chooses the sizes; only the MySQL and Redis switches
   below enable them. **Memory budget** shows RAM split between the services
   at the profile's sizes and PHP's worst case, and what to change when PHP
   does not fit. Only the profile is saved: the sizes are
   worked out again each time MySQL or Redis starts, so after you resize the
   server they follow its new RAM at the next boot.
2. Switch on **Size MySQL to this server** to replace CloudPanel's fixed MySQL
   values with the profile's buffer pool, connection limit and smaller
   per-connection buffers. It writes `zz-clp-addons-memory.cnf` next to
   CloudPanel's `mysqld.cnf`. A **Working** indicator beside the setting shows
   while it saves and checks the sizes. It never restarts MySQL by itself: the
   card shows **Pending** with a **Restart MySQL** button until the next
   restart. Press it when it suits you; every site loses its database for a few
   seconds while MySQL restarts.

   More connections at once than the limit get *Too many connections*.
3. Switch on **Cap Redis** to limit Redis to the profile's share. When it is
   full, Redis evicts the keys used least recently. It applies at once. Leave
   it off if a site keeps a job queue or other data in Redis it cannot lose.
4. **Protect MySQL and nginx when memory runs out** is on by default. When the
   server runs out of memory, the kernel kills a site's PHP worker, failing one
   request, instead of MySQL or nginx, which would take every site down.
   This protection is independent of the profile and sizing switches.

To turn sizing off, switch off **Size MySQL to this server** and **Cap Redis**.
The card then says **Sizing off**; the saved profile can still be previewed.
Each service returns to its own configured limits: Redis at once, MySQL at its
next restart. The out-of-memory protection has its own switch.

The budget preview includes each PHP pool's workers × its CloudPanel memory
limit. It is an estimate, not measured usage: PHP extensions and other services
need extra room. Unlimited or unreadable PHP limits leave the remainder unknown.

## Abandoned temp files

While System Tweaks is off, Resource Limits clears the PHP and ImageMagick temp
files timed-out requests leave in `/tmp`, so a box without System Tweaks keeps
that cleanup. See [System Tweaks](system-tweaks.md#abandoned-temp-files).
