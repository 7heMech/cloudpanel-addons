# Firewall

Firewall holds who may reach the server's sites and ports: CloudPanel's
per-site "Allow traffic from Cloudflare only" setting, across every site, and a
protocol for each rule on CloudPanel's own Firewall page.

## Cloudflare-only sites

The addon manages CloudPanel's existing `allow_traffic_from_cloudflare_only`
site setting. Enabling it updates the site row, changes the rendered access log
from `main` to `cloudflare`, and adds
`include /etc/nginx/cloudflare/ips;` to that site's Nginx vhost. Disabling it
reverses those rendered-vhost changes. CloudPanel remains the source of the IP
ranges in `/etc/nginx/cloudflare/ips`. Those rules check `$remote_addr`, which CloudPanel lets
any client set with `X-Real-IP`; [System Tweaks](system-tweaks.md#forged-visitor-ips)
closes that by default.

Bulk changes take one exclusive addon lock and one immediate SQLite transaction.
Every affected vhost must be a trusted regular file. The trust checks, owned
atomic replacement, restoration and recovery error collection are shared with
WordPress sign-in in `lib/nginx-transaction.ts`. The action stages all
changes, runs `nginx -t`, reloads Nginx once, and commits the database only when
the reload succeeds. On failure it restores the original vhosts while holding
the SQLite write lock, then rolls back the database. If any recovery step fails, the action attempts the remaining
steps and reports each failure with the original operation error.

## Dashboard

The site table comes first. From six sites a search and an Off only toggle
appear, and the headings sort. How many sites are Cloudflare only joins the
site count beside the search then, "20 sites · 9 Cloudflare only", so the
header holds only the selection; with fewer it stays under the title. The toggle
is the shared filter with one criterion, so it is a button highlighted while on
rather than a one-item menu. Enable selected and
Disable selected act on the ticked rows, which the filter keeps to rows on
screen. Their confirmation counts the sites whose setting changes, and an
enable says that a site not proxied through Cloudflare stops answering; a
selection that would change nothing is reported and not sent. Nothing is
restored afterwards. A per-site switch acts immediately without confirmation,
because turning one site off is the ordinary correction after a bulk change.
"Enable on new sites" is a switch below the table, and the Protocols card
comes last.

Selection checkboxes stay separate from the per-site switch, and the
selected-scope actions are unavailable until something is selected. On desktop,
the checkbox remains visible; at 940px or narrower, where rows become cards, the
whole site row selects with a highlight and the checkbox disappears to give the
site card its width back.

After any change the page repaints from a fresh read rather than from what was
requested, keeping selection, search and scroll, and does the same after a
failure so the displayed state is the server's. That read is part of the
change: the controls stay disabled until it returns, so a second action cannot
overtake the first, and a change whose read failed is reported as done but
possibly out of date rather than as plain success.

## New-site policy

The optional policy records CloudPanel site IDs that already existed when the
policy was enabled. The shared new-site watcher (see
[Platform](platform.md#new-sites)) runs the check seconds after CloudPanel
saves a new site, and repair runs it every 15 minutes. An unseen site ID
is treated as a newly created site and receives Cloudflare-only access. This
also handles deletion and recreation of the same hostname because the new site
has a new ID.

Each new site is changed in its own Nginx transaction. A site whose vhost
cannot be changed, such as one edited by hand, is logged by domain and left out
of the known IDs, so the next pass tries it again; the other sites are applied
and recorded.

Turning a site off in the addon records its hostname as an exception, and the
check does not re-enable an exception. Turning the site on removes it. Enabling
or disabling the policy does not change existing sites.

## Protocols

CloudPanel's Firewall page (Admin → Security → Firewall) opens every rule for
TCP only, so a UDP port such as WireGuard's or DNS needed ufw by hand. That does
not last: every add, edit or delete there runs `ufw --force reset`, re-adds each
row of its `firewall_rule` table with `ufw allow proto tcp from <source> to any
port <range>`, adds UDP 443 for HTTP/3 from `0.0.0.0/0` and `::/0`, and enables
ufw. Anything else, an edit to `/etc/ufw/*.rules` included, is gone after the
next change on that page. The table has no protocol column, and Symfony refuses
a field its form does not declare.

So Firewall keeps the protocol itself, in
`/var/lib/clp-addons/firewall/protocols.json`, keyed by what the rule is:
its port range, as CloudPanel's form stores it, and its source, as ufw writes
it (`"51820 0.0.0.0/0": "udp"`). CloudPanel already refuses two rows with the
same port range and source. A protocol applies only to rows that match exactly;
every other row is TCP, CloudPanel's own, so choosing TCP deletes the entry.
Rule ids are not used: a rebuilt table (a restore, a CloudPanel migration) can
give an id to another rule, which a stored "UDP only" would then strip of TCP,
SSH included, and ids say nothing on a box whose rules were renumbered. Rows
whose source differs only in spelling (`203.0.113.9` and `203.0.113.9/32`) share
a protocol.

It adds a Protocol field (TCP, UDP, TCP and UDP) after Port Range on the add and
edit forms, and a Protocol column after Port Range in the table, which fills
from the `protocols` verb. The field, heading and cells are hidden until
Firewall answers with its Protocol switch on. The field has no name. Both forms
send their Port Range, Source, protocol and, on the edit form, the rule's id to
`set-protocol`, then submit. That refuses UDP
alone for port 8443, which would close CloudPanel's own panel to TCP, and a
change to a port range and source another rule already has, since CloudPanel
then refuses the form as a duplicate or saves a row that shares the protocol. A
failed request stops the form with an error. Firewall's page has a Protocols
card: the switch, and the UDP ports the protocols open.

The form sends its choice before CloudPanel saves the row, and a pass can run in
between, so an entry no row has matched yet waits an hour. One that matched and
no longer does is forgotten at once: deleting a rule, or editing its port range
or source, retires it. An entry left by a form CloudPanel refused can only ever
apply to a rule with exactly its port range and source.

`clp-addons-firewall.path` watches `/etc/ufw/user.rules` and `user6.rules`
while Firewall is enabled, which is how it learns that CloudPanel rebuilt
ufw; the 15-minute repair runs the same pass. `clp-addons sync-firewall` runs
each installed addon's `firewall` hook. The pass waits until both files have
been still for two seconds, since the rebuild writes them once per command,
then, under its own lock, forgets entries as above and compares ufw's `### tuple ###` lines with the protocols. Sources are
compared the way ufw records them: the network address, without `/32` or
`/128`, IPv6 compressed. It repeats until a pass changes nothing, at most five
times, so a rebuild still running when it starts is caught, and refuses to loop
on commands ufw does not take. Its own writes wake the watcher once more, which
finds nothing to do.

It touches only what a protocol asks for. UDP adds `allow proto udp` and deletes
CloudPanel's TCP rule for that port and source, unless another TCP rule for both
still wants it; TCP and UDP adds the UDP rule. Additions run before deletions.
The rules it changed are recorded, so a rule set back to TCP, or every rule when
Firewall or its Protocol switch is off, goes back to CloudPanel's own: TCP
for each row, and UDP 443 untouched. Rules the operator added for other ports
are left alone, until CloudPanel's next rebuild removes them as it always did.
ufw runs with argument arrays; ports and sources from the table must match a
port, a range, an address or a CIDR, or the row is skipped.

Disabling marks the protocols withdrawn under the same lock before putting
ufw back, because that change wakes the watcher, which must not apply them
again. A failure there warns and does not keep Firewall on. Enabling clears
the mark and applies the kept protocols. The switch records `off` under the
lock, then runs the same pass as enabling, which reads the switch itself: off
withdraws, on applies. Two quick changes therefore end in the later one's
state, whichever pass runs last. A withdrawal that failed part way keeps the
rules it could not put back as changed, and the watcher's and repair's passes
finish it. The switch is on by default: it only offers the field, and every
rule stays TCP until someone picks UDP.

CloudPanel v3: CloudPanel's own migration carries the rules, and keying by
port range and source is what lets the choices follow them. Without the addon,
a UDP rule comes back as TCP.

## Taking over from earlier releases

Earlier releases shipped the site setting as Cloudflare IP Access
(`cloudflare-ips`) and the protocols in System Tweaks. Install and repair rename
`cloudflare-ips` to `firewall` the way other renamed addons move
(`RENAMED_ADDONS` in `cli/addons.ts`), then move System Tweaks'
`firewall.json` to `firewall/protocols.json` (`addons/firewall/migration.ts`),
holding the earlier version's locks. Where System Tweaks is enabled and was
applying a protocol, Firewall is enabled too, so a UDP rule does not fall back
to TCP; enabling it that way switches off an "Enable on new sites" saved while
Cloudflare IP Access was disabled, which would otherwise protect every site
created since. Choices System Tweaks had withdrawn arrive with the Protocol
switch off, so neither an enabled Firewall nor enabling it brings them back. A
file with no choices, or one that does not parse, is removed rather than moved;
one beside an existing `protocols.json` is dropped with a warning, so the move
is not retried on every repair. A failed update moves both back.
