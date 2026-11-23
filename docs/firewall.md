# Firewall

Cloudflare-only access for your sites, UDP rules on CloudPanel's own
Firewall page, a gate in front of the panel, and Hetzner Cloud or netcup
firewalls that admit only Cloudflare.

## Cloudflare-only sites

The table switches CloudPanel's **Allow traffic from Cloudflare only** for each
site, or for every selected site at once. A site that is not proxied through
Cloudflare stops answering once it is on. **Enable on new sites** turns it on
for each site created from then on; a site you turn off is never turned back on.

## Protocols

With **Protocols** on, CloudPanel's own **Admin → Security → Firewall** gets a
**Protocol** for each rule: TCP, UDP, or TCP and UDP. Choose it on **Add Rule**
or a rule's edit page, after **Port Range**. The rules table shows it in its
**Protocol** column, and Firewall's page lists the UDP ports that are open. A
protocol belongs to the rule's port range and source. UDP alone is refused for
port 8443, which would close CloudPanel itself to TCP; choose TCP and UDP there.

The change reaches ufw a few seconds after the page saves, and stays through
later changes on the Firewall page. Check it with `ufw status`. Switching
Protocols off, or disabling Firewall, sets every rule back to TCP in ufw and
keeps the choices for when it is on again.

## Panel gate

With the **Panel gate** on, CloudPanel answers only at its custom domain,
through Cloudflare, after a Cloudflare Access sign-in: Access emails a one-time
code to a panel user's address. `https://<server IP>:8443` stops answering.
It is off by default, and the card lists what it still needs:

- a custom domain for CloudPanel (**Admin → Settings**), with its record
  proxied through Cloudflare (the orange cloud) and the zone in SSL mode Full
  or Full (strict);
- a DNS connection whose token reaches that zone and holds
  **SSL and Certificates: Edit**, **Access: Apps and Policies: Edit** and
  **Access: Organizations, Identity Providers, and Groups: Edit**, besides
  **API Tokens: Read**. Add them to the token in Cloudflare; DNS lists them as
  optional;
- Cloudflare Zero Trust set up on the account (the free plan is enough).

Panel users added, removed or deactivated are kept in the Access policy within
15 minutes. Let's Encrypt still reaches `/.well-known/acme-challenge/` to
renew the domain's certificate. If you change CloudPanel's custom domain while
the gate is on, the new one is refused until you turn the gate off and on
again. Disabling Firewall turns the gate off; enabling Firewall again leaves it
off. The card shows anything changed since: the Access application, origin
pulls, the token's permissions, or the Nginx edits.

If you are shut out, reach the panel through an SSH tunnel:

```sh
ssh -L 8443:127.0.0.1:8443 root@<server IP>
```

then open `https://127.0.0.1:8443`. To take the gate off the server without
Cloudflare, run as root (it says what Cloudflare still has, which the next
repair deletes):

```sh
clp-addons firewall panel-gate off
```

## Hetzner Cloud Firewall

On a Hetzner Cloud server, Firewall can block everything but Cloudflare at
Hetzner, before it reaches the server. Elsewhere the card says the server is
not a Hetzner Cloud server. Dedicated (Robot) servers are not covered.

Choose **Connect Hetzner** on the card:

1. **Open Hetzner Console**, open the project that holds this server (the
   dialog names it), then **Security → API tokens → Generate API token**, with
   **Read & Write**. Hetzner has no link that fills the form in, and none that
   opens one project's tokens without knowing its id.
2. Paste the token and choose **Connect**. The page never shows it again;
   **Replace token** and **Remove token** are on the card.

Once any firewall is attached, Hetzner drops whatever no attached firewall
allows. On a server with no firewall yet, the first switch you turn on
therefore closes SSH, and the ports CloudPanel's Firewall page opens that the
addon's firewalls do not; 80, 443 and 8443 stay reachable. Site users lose
SFTP. The review lists exactly what closes, and you type the server's name to
go ahead. Hetzner's web console still gives a root shell, and so does the
Terminal addon while the panel answers, for an administrator root allows one
(`clp-addons terminal root allow <user>`). To keep SSH, first attach a firewall
of your own that allows it.

**Sites through Cloudflare only** attaches `clp-addons-cloudflare-web`: ports
80 and 443 answer only Cloudflare. Before it does, it lists the sites that do
not resolve to Cloudflare; they stop answering.

**Panel through Cloudflare only** attaches `clp-addons-cloudflare-panel`: port
8443 answers only Cloudflare, so `https://<server IP>:8443` stops answering.
It needs a custom domain for CloudPanel (**Admin → Settings**) proxied through
Cloudflare (the orange cloud), and Cloudflare must reach port 443, through the
sites switch or a firewall of yours. The panel then answers only at that
domain.

Both are off by default. Off means anyone can reach those ports: turning a
switch off, or turning the other one on, attaches `clp-addons-open-web` or
`clp-addons-open-panel` where no firewall of yours allows the ports. A port
your own firewall closed on purpose stays closed. With both switches off and no
firewall of yours, the addon takes all of its firewalls off.

If another of your firewalls still lets anyone reach those ports, the card says
so: the addon's firewall has no effect until you change that one. The firewalls
follow Cloudflare's list, and a rule changed in Hetzner's console is put back
within 15 minutes. Several servers in one project share the addon's firewalls.
Disabling Firewall leaves them attached and no longer kept current; turn the
switches off first. Removing the token leaves the open firewalls attached.

If the panel's domain stops working, reach the panel through an SSH tunnel:

```sh
ssh -L 8443:127.0.0.1:8443 root@<server IP>
```

then open `https://127.0.0.1:8443`. With SSH closed too, use the server's web
console in Hetzner's console, or remove the firewalls from the server under
**Firewalls** there.

Setup suggests turning the switches on, and shows **Action needed** when
Firewall has not been able to read Hetzner with the saved token for an hour.

## netcup firewall

On a netcup server (vServer or root server), Firewall can do the same with
netcup's firewall policies. The card shows only on a netcup server; on one,
the Hetzner card is hidden.

Choose **Connect netcup**. The dialog shows a code and a link to netcup's
sign-in: sign in with the customer number of the account that holds this
server, check that netcup shows the same code, and grant access. The card
finds this server in the account by its network card or public addresses (IPv4
or IPv6), and says so when no server there has it. **Connect again** and
**Disconnect** are on the card; Disconnect also asks netcup to revoke the
sign-in.

The firewall must be set up and on for the server in SCP (**Firewall →
Configure**). The switches work as on Hetzner, with policies named
`clp-addons-cloudflare-web`, `clp-addons-cloudflare-panel`,
`clp-addons-open-web` and `clp-addons-open-panel`; they go after your own
policies on the server. Once any policy has an inbound rule, netcup drops what
no policy allows, and the review lists what closes. netcup tracks only TCP, so
the addon's policies accept replies to the server's own DNS and NTP queries
(UDP from source ports 53 and 123 to ports 32768-60999), and ICMP and ICMPv6
from anyone, for path MTU discovery and IPv6. Replies to other UDP traffic the
server starts need a rule of your own. With SSH closed, SCP's
console still gives a root shell.

Policies are shared by the servers of one account and are never deleted.
Setup shows **Action needed** when Firewall has not been able to read netcup
for an hour; netcup ends a sign-in that goes unused, so connect again then.
