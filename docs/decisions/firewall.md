# Firewall

Firewall holds who may reach the server's sites and ports: CloudPanel's
per-site "Allow traffic from Cloudflare only" setting, across every site, a
protocol for each rule on CloudPanel's own Firewall page, and Hetzner Cloud
Firewalls that let only Cloudflare reach the web ports and the panel.

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
"Enable on new sites" is a switch below the table, then the Protocols card,
and the Hetzner Cloud Firewall card comes last.

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
again. A failure there warns and does not keep Firewall on: with the addon
disabled, neither the watcher nor repair runs for it, so a UDP rule it could not
take back stays in ufw until the next change on CloudPanel's Firewall page
rebuilds ufw without it, or until Firewall is enabled and disabled again.
Enabling clears
the mark and applies the kept protocols. The switch records `off` under the
lock, then runs the same pass as enabling, which reads the switch itself: off
withdraws, on applies. Two quick changes therefore end in the later one's
state, whichever pass runs last. A switch-off that failed part way keeps the
rules it could not put back as changed, and the watcher's and repair's passes
finish it while Firewall stays enabled. The switch is on by default: it only offers the field, and every
rule stays TCP until someone picks UDP.

CloudPanel v3: CloudPanel's own migration carries the rules, and keying by
port range and source is what lets the choices follow them. Without the addon,
a UDP rule comes back as TCP.

## Hetzner Cloud Firewall

On a Hetzner Cloud server, Firewall blocks at Hetzner rather than on the box,
so traffic it refuses never reaches the server. Once any firewall is attached
to a server, Hetzner drops all inbound traffic no attached firewall allows, and
several attached firewalls allow the union of their rules. Robot (dedicated)
servers have a different firewall API and are not covered.

The server's id comes from the metadata service,
`http://169.254.169.254/hetzner/v1/metadata/instance-id`, with a 1.5-second
deadline; anything but a number there means this is not a Hetzner Cloud
server, and the card says so and offers nothing. Before a token, the card
names the server from `…/metadata/hostname`, its name when it was created, so
the operator can find its project. Changes ask twice. Once a token is
connected the id is kept in `hetzner.json`, so a moment's silence
from the service does not hide the switches or skip the check before the token
is removed. Without a token the page believes the silence for ten minutes, so
a server off Hetzner Cloud whose link-local address is filtered does not wait
on every load.

### Four firewalls per project

Several servers may run the addon in one Hetzner project, so each firewall it
owns is shared, and its content is the same wherever it is computed:

- `clp-addons-cloudflare-web`: inbound TCP 80 and 443 from Cloudflare's ranges.
- `clp-addons-cloudflare-panel`: inbound TCP 8443 from Cloudflare's ranges.
- `clp-addons-open-web`: inbound TCP 80 and 443 from anyone.
- `clp-addons-open-panel`: inbound TCP 8443 from anyone.

Each carries `managed-by=clp-addons` and `clp-addons-role=web|panel`, and the
open ones `clp-addons-access=open`; each is found by those labels, never by
name. Only a firewall with the label is ever changed; a firewall that has the
name but not the label refuses the switch. The Cloudflare rules are a pure function of the
list: one rule per port, the ranges in canonical `network/prefix` form, IPv4
before IPv6, each family by address, and a fixed description. The open rules
are fixed. Rules are compared with Hetzner's by a signature that ignores order
and address spelling, and `set_rules` runs only when they differ.

The list is CloudPanel's own `/etc/nginx/cloudflare/ips`, which CloudPanel
refreshes daily. It is read only from a regular file root or the panel
account owns and nobody else can write, and parsed strictly: every line must be
`allow <network>/<prefix>;`, `deny all;`, blank or a comment; a range with host
bits set or wider than /8 (IPv4) or /16 (IPv6) is refused; and both families
must be present. A file that is missing, empty or malformed changes nothing and
fails the pass with the reason, since an empty source list would shut out
every visitor.

Two servers whose lists differ, for the hours between their daily refreshes,
must not rewrite each other's rules on every repair. The writer stores its
list's modification time in the `clp-addons-ranges-at` label, and a server
whose own list is older leaves the rules alone and says so. Servers whose lists
agree write nothing. The time says nothing about the content: a server whose
file is newer but holds an older list, such as a restored copy, wins until the
others' next daily refresh, which is newer again. A time more than a day ahead
of the reader's clock is ignored, so a wrong clock cannot hold the rules.

### Attaching and keeping current

A switch attaches its Cloudflare firewall to this server by server id; label
selectors are never used. The first server creates the firewall with
`apply_to` in the same request, so it never exists unused; a later one brings
its rules current and applies it, whichever server's list wrote its rules. A
create refused as a duplicate name is read back by label, since another server
may have created it a moment earlier, and an apply to a firewall deleted in
between creates it again, once; a second deletion fails the switch. A firewall
taken off this server is deleted if nothing else uses it; Hetzner refuses to
delete one still applied, which covers a server attaching it in between.
Repair also deletes an owned firewall applied to nothing.

A switch that is off means anyone can reach its ports. Without the open
firewalls, taking the Cloudflare one off would close the ports to everyone
whenever the remaining firewalls allow SSH but not them, and attaching the
first firewall to a server would close 8443. So each change plans the addon's
firewalls on this server together: a role whose switch is off gets its open
firewall when no firewall of the operator's allows any of its ports, and the
ports would otherwise close: no firewall was attached, its Cloudflare firewall
is coming off, or its open one is already there. The open firewall opens all
of the role's ports, so where the operator's firewalls allow some of them, a
port they leave closed stays closed, and the review names it. With no switch on and no firewall of the
operator's, the plan is empty and Hetzner lets anyone reach every port again.
Open firewalls go on first and come off last, so for the few seconds a change
takes nothing the plan keeps open is closed, beyond what the first attach
closes. Hetzner applies at most five firewalls to a server: a change that would
leave more is refused, and one with no room to add first takes off first.
Per role only one of the two is meant to be on a server; an open firewall left
beside its Cloudflare one by a change that failed half way only lets everyone
else in, so the card warns, and repair or a request to turn the switch on
takes it off.

Repair (every 15 minutes) reads the owned firewalls with one paginated
`GET /firewalls?label_selector=…` and this server, puts back any rule changed
in Hetzner's console and writes nothing when nothing differs. The anchor watcher, which sees
CloudPanel rewrite the list, runs the same pass only when a hash of the parsed
list differs from the last pass's, so its frequent wakes cost no API call. The
page reads the server and all firewalls, two requests, on each load. Hetzner
limits a project to 3600 requests an hour; the addon adds no limits of its own.

Disabling Firewall leaves the Hetzner firewalls as they are: detaching one
could close 80 and 443 to everyone, when the other attached firewalls do not
allow them, or open every port, when none is left. The operator turns the
switches off first.

### Safeguards

Every refusal and warning is computed by the root action when the switch is
used, and again when it is confirmed. A switch first answers with a review and
a digest of it; only a request carrying the digest of the review as it stands
then makes the change, so a review that changed in between is shown again. The
review comes in parts the page lays out separately: what changes, the
hostnames that stop answering, what leaves it without effect, the ports that
close, the way back, and, when ports close, the server's name to type.

- Closing ports: the review compares what can be reached before and after the
  change for the ports sshd listens on, from `ss -Htlnp` (processes named
  `sshd`) or from `sshd -T` when ss shows none, and for each rule on
  CloudPanel's Firewall page, with its Protocol. With no firewall attached,
  everything can be reached; otherwise a port needs one inbound rule covering
  it, from any source, for IPv4 and for IPv6 apart, and a port that keeps only
  one family is named for the other. Each port that closes is named, SSH as the loss of SFTP
  for site users, and the operator types the server's name to go ahead. A
  refusal would be stricter than needed: the Terminal addon gives a root shell
  through the panel, its output as server-sent events through both Nginx
  hops in front of the custom domain, and Hetzner's web console works whatever
  is attached. SSH another firewall already closed is not the change's doing,
  so the card shows it instead, with a link to Terminal while it is enabled.
- Panel: CloudPanel's custom domain (`/etc/.clp_custom_domain`, while its
  vhost exists) must exist and resolve, on A and AAAA, only to addresses inside
  the list. CloudPanel serves that domain from the sites' Nginx on 443, not on
  8443, so every Cloudflare range must also reach 443 through the firewalls
  the change leaves on this server. The review then says the panel answers
  only at that domain, and that an SSH tunnel to `127.0.0.1:8443` is the way
  back, or Hetzner's web console when SSH closes too.
- Sites: the review lists every hostname the sites answer to, each site's
  domain and the other names in its vhost's `server_name`, and the custom
  domain, whose A or AAAA records include an address outside the list: those
  stop answering. A name that does not resolve answers no one already and is
  left out.
- No effect: a source another attached firewall allows to the same ports that
  is not inside the list leaves the addon's firewall without effect. The review,
  the result and the card name the port, the firewall and the sources
  ("443 is still open to anyone through firewall X") instead of success.
- Off: the review says which firewall takes the Cloudflare one's place, or
  that nothing of the addon's stays. Turning sites off is refused while the
  panel switch is on and the firewalls left would not let Cloudflare reach
  443, which the custom domain needs.

### The token

The token is a Hetzner Cloud API token with Read & Write, scoped to one
project; it can delete servers. It is pasted into a Connect Hetzner dialog laid
out like DNS's Connect Cloudflare, whose button opens Hetzner Console's project
list: Hetzner's token form takes nothing from the link, and a project's token
page is `/projects/<id>/security/tokens`, whose id neither the metadata
service nor the API gives. It reaches the root action on stdin, is
accepted only as 32 to 128 letters and digits, so it can only ever be a header
value, and is checked with `GET /servers/<id>`, which also proves the project
holds this server. It is kept in `/var/lib/clp-addons/firewall/hetzner-token.json`
through `lib/root-state.ts` (root-owned, mode `0600`, replaced atomically), and
sent only in the Authorization header through `lib/provider-http.ts`, which
DNS uses too; every message from Hetzner is redacted of it. The page learns
only whether one is saved. A read cannot tell a read-only token, so the first
change reports it. Removing the token is refused while one of its Cloudflare
firewalls is attached to this server; the open ones stay, since their rules
never change, and the result says so. When Hetzner cannot be asked, or no longer accepts the
token, it is removed anyway, since a leaked token must always be removable, and
the result says what could not be checked.

### What the Setup checklist reads

`hetzner.json` keeps which switches were on when Hetzner was last read and
when: the page's read, a switch and repair each write it. `hetznerSetupState`
returns that, whether a token is saved, and whether this is Hetzner Cloud
(`/sys/class/dmi/id/sys_vendor` is `Hetzner`, or a token is saved), without
asking Hetzner, so the checklist costs no request when a page loads.

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
