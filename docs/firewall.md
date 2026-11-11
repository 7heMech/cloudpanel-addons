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

Choose **Connect Hetzner** on the card:

1. **Open Hetzner Console**, open the project that holds this server (the
   dialog names it), then **Security → API tokens → Generate API token**, with
   **Read & Write**. Hetzner has no link that fills the form in, and none that
   opens one project's tokens without knowing its id.
2. Paste the token and choose **Connect**. The page never shows it again;
   **Replace token** and **Remove token** are on the card.

Once any firewall is attached, Hetzner drops whatever no attached firewall
allows. On a server with no firewall yet, the first switch you turn on
therefore closes SSH and every other port CloudPanel's Firewall page opens.
Site users lose SFTP. The review lists those ports, and you type the server's
name to go ahead. Hetzner's web console still gives a root shell, and so does
the Terminal addon while the panel answers. To keep SSH, first attach a
firewall of your own that allows it.

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
