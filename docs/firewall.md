# Firewall

Cloudflare-only access for your sites, and UDP rules on CloudPanel's own
Firewall page.

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
