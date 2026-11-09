# Firewall

Cloudflare-only access for your sites, UDP rules on CloudPanel's own
Firewall page, and Hetzner Cloud Firewalls that admit only Cloudflare.

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

## Hetzner Cloud Firewall

On a Hetzner Cloud server, Firewall can block everything but Cloudflare at
Hetzner, before it reaches the server. Elsewhere the card says the server is
not a Hetzner Cloud server. Dedicated (Robot) servers are not covered.

Before you start, attach a firewall of your own to the server in Hetzner's
console that allows SSH. Once any firewall is attached, Hetzner drops whatever
no attached firewall allows, so Firewall refuses to attach anything until one
allows the port sshd listens on.

1. In [Hetzner Cloud Console](https://console.hetzner.cloud/), open the
   project the server is in, then **Security → API tokens → Generate API
   token**, with **Read & Write**.
2. Paste it into **Hetzner Cloud Firewall** on Firewall's page and choose
   **Connect**. The page never shows it again; **Replace token** and **Remove
   token** are on the card.

**Sites through Cloudflare only** attaches `clp-addons-cloudflare-web`: ports
80 and 443 answer only Cloudflare. Before it does, it lists the sites that do
not resolve to Cloudflare; they stop answering.

**Panel through Cloudflare only** attaches `clp-addons-cloudflare-panel`: port
8443 answers only Cloudflare, so `https://<server IP>:8443` stops answering.
It needs a custom domain for CloudPanel (**Admin → Settings**) proxied through
Cloudflare (the orange cloud), and Cloudflare must reach port 443, through the
sites switch or a firewall of yours. The panel then answers only at that
domain.

Both are off by default. If another of your firewalls still lets anyone reach
those ports, the card says so: the addon's firewall has no effect until you
change that one. The firewalls follow Cloudflare's list, and a rule changed in
Hetzner's console is put back within 15 minutes. Several servers in one
project share the two firewalls. Disabling Firewall leaves them attached and no
longer kept current; turn the switches off first.

If the panel's domain stops working, reach the panel through an SSH tunnel:

```sh
ssh -L 8443:127.0.0.1:8443 root@<server IP>
```

then open `https://127.0.0.1:8443`. Locked out of SSH too, remove the
firewalls from the server under **Firewalls** in Hetzner's console, or use the
server's web console there.
