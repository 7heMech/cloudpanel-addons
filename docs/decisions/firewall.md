# Firewall

Firewall holds who may reach the server's sites and ports: CloudPanel's
per-site "Allow traffic from Cloudflare only" setting, across every site, a
protocol for each rule on CloudPanel's own Firewall page, a gate in front of
the panel, and Hetzner Cloud Firewalls or netcup firewall policies that let
only Cloudflare reach the web ports and the panel.

## Cloudflare-only sites

The addon manages CloudPanel's existing `allow_traffic_from_cloudflare_only`
site setting. Enabling it updates the site row, changes the rendered access log
from `main` to `cloudflare`, and adds
`include /etc/nginx/cloudflare/ips;` to that site's Nginx vhost. Disabling it
reverses those rendered-vhost changes. CloudPanel remains the source of the IP
ranges in `/etc/nginx/cloudflare/ips`. Those rules check `$remote_addr`, which
CloudPanel's Nginx before `nginx-common` 1.30.6-2 lets any client set with
`X-Real-IP`; [System Tweaks](system-tweaks.md#forged-visitor-ips) closes that by
default.

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

## Panel gate

### The threat

CloudPanel's panel runs on PHP 8.1, which is end-of-life, beside a File Manager
pool that runs as root. Its Nginx (`clp-nginx`, `cloudpanel.conf`) has
`server_name _` on 8443 and answers any client and any Host. PHP parses a
request's body before the panel's login runs, so a pre-auth PHP bug reaches
it from anywhere. The gate lets only requests that passed the operator's
Cloudflare Access sign-in, for the operator's own hostname, reach that PHP.

An allow-list of Cloudflare's addresses is not enough: every Cloudflare
account shares them, so anyone can point a zone of their own at the server and
send any Host through it. A Cloudflare Tunnel would replace CloudPanel's own
custom-domain path with a daemon to keep running, and its outage would close
the panel; the gate keeps CloudPanel's path and adds two checks to it.

### What it changes

CloudPanel's custom domain is a server block of the sites' Nginx,
`/etc/nginx/sites-enabled/custom-domain.conf`, on 80 and 443, which proxies to
`https://127.0.0.1:8443/`. Port 80 there only redirects to HTTPS.

- **Per-hostname Authenticated Origin Pulls.** The gate makes its own RSA key
  and self-signed client certificate (`CN=clp-addons panel gate`, ten years,
  `clientAuth`, a leaf, since Cloudflare refuses a CA), written with `O_EXCL`
  and mode `0600` to `/etc/clp-addons/panel-gate/`, a directory only root can
  open. It uploads them with
  `POST /zones/{zone}/origin_tls_client_auth/hostnames/certificates` and enables
  them for the custom domain alone with `PUT …/hostnames`. Cloudflare then
  presents that certificate only when it connects to this server for that
  hostname in the operator's zone. Zone-level origin pulls are never used: their
  certificate is Cloudflare's shared one, which any account's zone presents.
- **The custom domain** gets `ssl_client_certificate <our cert>;` and
  `ssl_verify_client on;` after its `server_name`, each line tagged
  `# clp-addons:panel-gate`. Nginx trusts the self-signed certificate as
  itself. A TLS client whose SNI names another site and whose Host names the
  panel gets 421 from Nginx, which refuses a Host whose server requires a client
  certificate the handshake's server did not ask for; no SNI at all meets
  `default.conf`'s `ssl_reject_handshake`.
- **The panel's 8443 server** gets a marked block first in it:
  `if ($realip_remote_addr !~ "^(?:127\.0\.0\.1|::1)$") { return 444; }`.
  `$remote_addr` would not do: the panel's Nginx rewrites it from
  `X-Forwarded-For` for trusted peers, 127.0.0.1 among them, so it is the
  visitor's address on every proxied request. First, because a later
  `if (-f $request_filename) { break; }` stops the server's rewrite directives
  for existing files. A second `if` returns 444 unless `$host` is the gated
  hostname, `127.0.0.1`, `localhost` or `[::1]`. `$host` is the Host header,
  or HTTP/2's `:authority`, in lower case and without the port, so the SSH
  tunnel and on-box requests keep working over either protocol. A custom domain
  CloudPanel is given after the gate is on proxies from loopback too, without
  the certificate or Access, and is refused here rather than let in. The
  `/addons/` proxy's baseline (`cli/inject.ts`) leaves the block out, as it
  does System Tweaks' phpMyAdmin rules.
- **Cloudflare Access.** The account's One-time PIN login is used, or created,
  and a reusable allow policy lists the emails of every active panel user
  (`status = 1`; admins, site managers and users). A self-hosted application for
  the hostname uses that policy and that login alone. Both are named
  `CloudPanel <hostname> (clp-addons panel gate)`, so a run that lost its state
  adopts them rather than making another pair; their ids are kept in
  `/var/lib/clp-addons/firewall/panel-gate.json`.
- **Let's Encrypt.** CloudPanel renews the custom domain's certificate over
  HTTP-01, which Access would turn away at the edge, and with Full (strict) the
  panel would then go dark at the only hostname the gate allows. A second
  self-hosted application, for `<hostname>/.well-known/acme-challenge`, has a
  Bypass policy for everyone; Access takes the more specific path first. It is
  named like the first with `: Let's Encrypt`, made, adopted, deleted and
  checked the same way. The challenge then reaches the server as any other
  request does: Cloudflare connects to 443 with the origin-pull certificate,
  which is per hostname rather than per path, and the panel serves
  `/.well-known` itself. DNS's `clp_dns_acme` rule, Full SSL for that path,
  keeps that connection working while the certificate is expired or not yet
  issued; Full still presents the origin-pull certificate. Port 80 is not
  involved: the custom domain's server only redirects there, and
  `ssl_verify_client` applies to TLS connections alone.

The Access token is not checked at the origin. A request reaches the
custom domain's 443 only with the client certificate, which Cloudflare presents
only for the operator's hostname in the operator's zone, where Access runs at
the edge before the origin pull. Checking the JWT as well would need a process
in front of PHP for every panel request, and that process failing would close
the panel. Local accounts can still connect to `127.0.0.1:8443`; the gate is
about remote clients, and loopback is the way back in.

### Before it turns on

Every check runs in the root action, when the switch is used and again when it
is confirmed; the page shows the review and sends its digest back, as the
Hetzner switches do. The review changes nothing, a clean-up of an earlier
gate included, so cancelling it leaves everything as it was. It refuses unless CloudPanel has a custom domain, both
vhosts have the shape the edits expect, an active panel user has an email, a
DNS connection's token reaches an active zone for the hostname (the longest),
the hostname has A, AAAA or CNAME records and all are proxied, and the token
holds SSL and Certificates: Edit on the zone and both Access permissions on
its account. Those three are in DNS's permission list (`addons/dns/token.ts`)
as optional, so a DNS token without them is fine until the gate is wanted; the
gate reads the token's own policies (`/user/tokens/{id}`) and checks them with
`addons/dns/access.ts`, so a token without API Tokens: Read is asked for it. A
zone in SSL mode Off or Flexible is refused, since Cloudflare would reach the
server over port 80, where the custom domain only redirects; when the mode
cannot be read (it needs Zone Settings: Read), the review says it must be Full
or Full (strict). The review says that the panel stops answering at the IP on
8443, how to get back in, and that Access emails a code.

### Order and rollback

Turning on runs, in order: make the certificate, upload it, enable it for the
hostname, wait up to 150 seconds by the clock for Cloudflare to report the
hostname `active` (a 429, a 5xx or a dropped connection is asked again), set
up Access, edit the custom domain (`nginx -t`, reload), then the
panel (`nginx -t -c` on its config, reload `clp-nginx`). Nginx asks for the
certificate only once Cloudflare presents it, and 8443 closes only once the
custom domain is the way in. Each step's undo is registered before its call
and each id saved as soon as it returns, so a change Cloudflare made whose
reply was lost is undone too: the certificate found by its PEM, the policy
and application by their name. A failing step undoes every earlier one in
reverse: each Nginx edit through the shared transaction, which restores the
file and reloads, then the Access application and policy, the hostname's
certificate (set to `null`, which Cloudflare needs before a delete), the
certificate and the files. The One-time PIN login stays, since other Access
applications may use it. What Cloudflare refused to undo is kept in the state
file and deleted by the next repair, which first takes out any Nginx edit a
run that stopped part way left, so the custom domain never asks for a
certificate Cloudflare no longer presents.

Turning off runs the other way: the panel's block, the custom domain's lines
and the files, then the Access application, its policy and the certificate.
Cloudflare failures leave the gate off and the objects for repair to delete.
Turning on again deletes what an earlier gate left first, once confirmed,
through its own DNS connection or another that reaches the same zone and
account, and refuses while that fails, so the record of those objects is
never dropped. A failure says what undoing it left, if anything.

Every change to the two Nginx files takes the platform's operation lock, which
repair and `cli/inject.ts` hold while they rewrite the panel's vhost, then the
gate's own lock, in that order; a confirmed switch, `panel-gate off` and
repair hold both from start to end.

### Getting back in

An SSH tunnel to `127.0.0.1:8443` always reaches the panel.
`clp-addons firewall panel-gate off`, as root, takes both Nginx edits out
without asking Cloudflare, for when Access or the token is the problem; repair
deletes the Cloudflare objects afterwards; its message names what Cloudflare
still has and where to delete it by hand when the token cannot. Disabling
Firewall turns the gate off: the Nginx edits first, then the Cloudflare
objects through `action firewall panel-gate-cleanup`, run as a child process
since disabling is synchronous. What that cannot delete waits, recorded, for
a repair once Firewall is enabled again, which leaves the gate off until the
operator turns it on.

### Keeping it

CloudPanel rewrites `custom-domain.conf` when an administrator saves the custom
domain, and a `cloudpanel` upgrade rewrites `cloudpanel.conf`. The anchor
watcher, which follows the panel's vhost and the sites' directory, and the
15-minute repair put both edits back. Until then the custom domain answers
without the certificate. A custom domain that changed is not gated: its new
hostname has no origin pulls, so the check would shut it out, and the panel's
Host check refuses it. Setup raises it as Action needed as soon as CloudPanel
writes the new name, and the card says the new domain is refused until the
gate is turned off and on again.

Repair puts the Nginx edits back, reads Cloudflare and syncs the policy as
separate steps: a failure in one is recorded as drift and the others still
run. It reads the token's permissions, the hostname's origin
pulls, the Access application and policy. It rewrites the policy when the
active panel users' emails differ, and keeps what else it finds wrong for the
page, which adds what it sees on disk: an Nginx edit gone, a moved custom
domain, a missing certificate file. Setup raises the same lines as Action
needed, "Panel gate needs attention", linking to the card:
`panelGateActionNeeded()` reads only those files and the drift repair
recorded, so it fits Setup's local-only checks and their time limit, and is at
most a minute behind through Setup's cache.

The page draws a gate that is off from local files alone and then asks the
`panel-gate` verb for what it needs, so Cloudflare's replies never hold the
site table back. Those reads run in parallel.

`bun tests/integration/integration-panel-gate.ts` runs both edits in real
Nginx in Docker: the custom domain refuses a request without the gate's
certificate or with another one, another SNI with the panel's Host gets 421
over HTTP/1.1 and HTTP/2, port 8443 drops a non-loopback client even with a
forged `X-Forwarded-For`, and a proxied visitor keeps their address.

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
Turning a switch on attaches its Cloudflare firewall first, so a refusal there
leaves what is attached as it was; a firewall it created or rewrote meanwhile
is tidied by repair. Open firewalls go on before any comes off, so for the few
seconds a change takes nothing the plan keeps open is closed, beyond what the
first attach closes. Hetzner applies at most five firewalls to a server: a
change that would leave more is refused, and one with no room to add first
takes off first, so a refused attach comes after that. A firewall taken off is
deleted only once every step held; a step that fails puts back what the earlier
ones did, and if that fails too, the error says what is attached.
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
  `sshd`), from `sshd -T` when ss shows none, or 22 in a review when neither
  names one, and for each rule on
  CloudPanel's Firewall page, with its Protocol. With no firewall attached,
  everything can be reached; otherwise a port needs one inbound rule covering
  it, from any source, for IPv4 and for IPv6 apart, and a port that keeps only
  one family is named for the other. Each port that closes is named, SSH as the
  loss of SFTP for site users, and the operator types the server's name to go
  ahead, which the root action checks too. CloudPanel's rules that cannot be
  read leave only SSH checked, and the review says so, rather than blocking
  the switch. A refusal would be stricter than needed: the Terminal addon gives
  a root shell through the panel to an administrator root allows, its output
  as server-sent events through both Nginx hops in front of the custom domain,
  and Hetzner's web console works whatever is attached. SSH another firewall already closed is not the change's doing,
  so the card shows it instead, with a link to Terminal while it is enabled.
- Panel: CloudPanel's custom domain (`/etc/.clp_custom_domain`, while its
  vhost exists) must exist and resolve, on A and AAAA, only to addresses inside
  the list. CloudPanel serves that domain from the sites' Nginx on 443, not on
  8443, so every Cloudflare range must also reach 443 through the firewalls
  the change leaves on this server. The review then says the panel answers
  only at that domain, and that an SSH tunnel to `127.0.0.1:8443` is the way
  back, or Hetzner's web console when SSH is closed or closes too.
- Sites: the review lists every hostname the sites answer to, each site's
  domain and the other names in its vhost's `server_name`, and the custom
  domain, whose A or AAAA records include an address outside the list: those
  stop answering. A name that does not resolve answers no one already and is
  left out of the list, and the review does not claim every site resolves to
  Cloudflare while any hostname did not resolve.
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
when: the page's read, a switch and repair each write it, under the Hetzner
lock and only while a token is saved, so a read racing the token's removal
cannot bring the file back. A page read skips the write while a change holds
the lock, and when something recorded after the read began. `hetznerSetupState`
returns that, whether a token is saved, and whether this is Hetzner Cloud
(`/sys/class/dmi/id/sys_vendor` is `Hetzner`, or a token is saved), without
asking Hetzner, so the checklist costs no request when a page loads. Setup
suggests the switches from it, and raises Action needed once a saved token's
`seenAt` is an hour old: repair reads Hetzner every 15 minutes and records only
when that works, so four misses in a row are a token Hetzner refuses or a
Hetzner that does not answer. A null `seenAt` has not been read yet and raises
nothing.

## Provider firewalls

Hetzner and netcup share `addons/firewall/cloud-firewall.ts`: reading and
checking Cloudflare's list, the two roles and their ports, the plan of which
open firewalls a change needs, the review and its safeguards, the card's view,
and the Setup state. Each provider maps its firewalls to a `Guard`, its inbound
rules in the order the provider applies them, and says whether it lets in what
no rule decides, now and after a change. A rule list is read first match wins
across port subranges, source-port ranges, and address intervals; Hetzner rules
only allow, so this is the union described above. Whether clients connect is
asked over their source ports, 1024–65535: a port counts as reachable after a
change only from every one, and as open before it from any one. What else lets
anyone past Cloudflare is asked over every source port. A port of `0` covers no
connection, so `0-65535` covers all. A port that cannot be read is taken the way
that errs safe: an unreadable accept matches when asking what is open, and an
unreadable drop when asking what still connects. Each provider keeps its own
API client, how it finds this server, its credential, and how it carries out a
plan.

## netcup firewall

netcup filters a server's interface by policies: lists of rules, shared by the
account's servers, assigned per interface through the SCP REST API
(`https://www.servercontrolpanel.de/scp-core/api/v1`, described by its OpenAPI
document at `…/openapi`). A server with no policy with an inbound rule lets
everything in; once one has an inbound rule, netcup drops what no rule
accepts. Its tracking of connections covers TCP only.

### Signing in

The API takes a bearer token from netcup's Keycloak realm `scp`. The addon
uses the device authorization grant with the public client `scp`, which the
realm's discovery document lists and netcup's own tools use, and the scopes
`openid offline_access`: the root action asks for a code, keeps the device
code in `netcup-device.json`, and returns only the user code and netcup's link
(checked to be on `www.servercontrolpanel.de`). The page shows them and asks
the root action, at the interval netcup gives, whether access was granted;
`slow_down` widens the interval; `access_denied`, `expired_token`,
`invalid_grant`, `invalid_client`, `unauthorized_client` or `invalid_request`
ends the attempt, and any other failure leaves the code for the page to ask
again until it expires. After the grant, `netcup-token.json` and `netcup.json`
are written together under the token lock; if writing `netcup.json` fails, the
previous token is restored (or the new one removed) and the new refresh token
is revoked. If restoring fails too, `netcup.json` is removed, so the new token,
now revoked, never sits beside the old account's state. Any failure before both are saved revokes the new token; replacing
a saved sign-in with an account that does not hold this server keeps the old
sign-in and state, revokes the new token, and fails. Only the refresh token is
kept, in `netcup-token.json` through `lib/root-state.ts`. Each read or change
exchanges it for an access token under its own lock, and saves the token
Keycloak returns before using the access token, since Keycloak may rotate it
on each use and two processes must never spend the same one. `invalid_grant`,
or a 401 from the API, is a sign-in netcup no longer accepts, and the card asks
to connect again. Disconnecting revokes the refresh token at the realm's
revocation endpoint and removes both `netcup-token.json` and `netcup.json`
under the token's lock, so a refresh running then cannot write a rotated token
back. It is refused while netcup's firewall is on and a Cloudflare policy is on
this server, as with Hetzner's token, and while netcup cannot be read for any
reason but refusing the sign-in, since a policy left on the server would stop
following Cloudflare's list unseen. When netcup's firewall is off,
disconnecting goes ahead and warns that any Cloudflare policy left on the
server will no longer follow the list. Messages are redacted of token and code
values.

The policy endpoints are under `/users/<id>`, the SCP user id, which is not the
customer number (the SCP username, userinfo's `preferred_username`). It is
userinfo's `id` claim when present and confirmed by `GET /users/<id>`; the
discovery document does not list one, so otherwise it is a user that
`GET /tasks` or this server's `GET /servers/<id>/logs` names under that
username and `GET /users/<id>` answers for. It is kept in `netcup.json`.

### This server

netcup has no metadata service. The card shows when
`/sys/class/dmi/id/sys_vendor` names netcup, or a sign-in is saved. The server
is found by what its interfaces carry (netcup routes addresses to the server
without NAT): its MACs, its public IPv4 addresses and its global IPv6 ones.
Matching runs in two passes: MAC across all candidates first, falling back to
addresses only when no MAC matches anywhere. Address matching ignores routed or
failover entries (`type: "ROUTED_IP"` or `destinationIp`) and accepts IPv6
prefix containment (`networkPrefix`/`cidr`) only for `/64` or longer prefixes.
`GET /servers?ip=<address>` is tried first, for each address; the spec does not
say it takes IPv6, so with no match every server's interfaces are checked,
paging through `GET /servers`. Disabled servers and 4xx replies (other than
401) from a single server's `/interfaces` are skipped. An IPv6-only server is
found that way. Its id, MAC and name are kept in `netcup.json`, written under
the netcup lock (a read that finds it busy leaves it to the change holding it,
and an unlocked read writes only when `netcup.json` still holds the same SCP
`userId` that started it);
a no-match result is cached for 15 minutes so page loads do not rescan, and a
page read is bounded to 25 seconds so a scan degrades the card rather than
failing the Firewall page. When netcup answers 404 for the kept interface, the
server is looked up again once. No match, or a server whose firewall is not set
up in SCP (404), is shown on the card, recorded as non-fatal in repair, and
still updates `seenAt` with the switches off so Setup does not report the
sign-in as unanswered. A firewall that is off makes the switches refuse, since
turning it on would also start netcup's default policies.

### Policies

The four policies carry the Hetzner firewalls' names and rules: one inbound
TCP accept rule per port and address family, sources in canonical form, a
fixed description. Each also accepts inbound ICMP (for path MTU discovery) and
ICMPv6 from anyone: any of them makes netcup drop by default, and without
neighbour discovery, router advertisements and Packet Too Big a server with
only IPv6 would be cut off. netcup has no labels, so a policy is the addon's when it
has one of the names and its description starts with `Managed by clp-addons`;
a policy with the name and not that refuses the switch. The writer's list time
is the end of the description (`; Cloudflare's list of <time>`), read like
Hetzner's label. A policy claiming a newer list is left alone only while it
still lets only Cloudflare in: TCP accepts on exactly the role's ports, the same
sources on each, both address families, every source inside this server's list,
and ICMP. Otherwise a switch or repair rewrites it to this server's list. A
newer list that adds a range therefore loses it until this server's list
catches up; only Cloudflare is let in throughout. The listing may leave out rules, so each owned policy is read
on its own before it is compared. Listings are paged until a page is empty or
brings no new id.

A change plans like Hetzner's, with netcup's default: it falls open while no
policy of the operator's or the addon's has an inbound rule, unless netcup
drops by default already without one, which the change keeps. Copied policies
(netcup's defaults) are read before the operator's; netcup does not document
that order. A change then makes at most one policy write per missing or stale
policy and one write of the interface's whole assignment: the operator's
policies in their order, then the addon's, the copied policies unchanged.
That write replaces the assignment at once, so nothing opens or closes in
between and a refused write (4xx) changes nothing; a policy created for it
stays unused. Writes answer with a task, which the addon waits for, retrying
transient task-poll errors up to a minute each (with each poll bounded by the
remaining task wait) and three minutes across a switch, with at most a minute
for the lock, so the page has its answer within the gateway's 240 seconds.
netcup took a change it answered with HTTP 202 or a task. A policy write
answers with no task when no server has the policy; it counts as done when the
policy netcup answers with has the rules and description written. Otherwise a
202 with no usable task id or a task still running when the wait ends is reported as taken with
unknown completion, and one that ends in `ERROR`, `ROLLBACK` or `CANCELED` as
failed, with SCP named for what the server has. Any other failure of the
assignment write says netcup may have taken it. Policies are never deleted: the
spec does not say what deleting one in use does to the servers that have it.
Repair rewrites drifted policies, takes an open policy off beside its role's
Cloudflare one, and records the switches. Turning a switch on when both the
Cloudflare and open policies are attached goes through the normal review and
confirmation before removing the open policy. The 500-rule limit per interface
is netcup's to refuse. netcup counts each source as a separate effective rule:
at most two of the addon's policies sit on a server at once, where each
Cloudflare policy holds one effective rule per source and port plus two for
ICMP and ICMPv6 (70 effective rules with both switches on and a 22-range list;
three more for each added range), and each open policy holds one wildcard TCP
rule per port plus the two ICMP rules (4 for web, 3 for panel).

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
