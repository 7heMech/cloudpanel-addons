# Cloudflare IP Access

Use **Addons → Cloudflare IP Access** to manage CloudPanel's **Allow traffic
from Cloudflare only** setting. Each site has its own switch. **Enable on new
sites** applies the setting automatically to newly created sites; the bulk
controls change existing sites.

## Mitigate Cloudflare-only bypass

This protection is **on by default**. It checks the actual connection address
so forged IP headers cannot bypass the Cloudflare-only rule.

**It applies only to sites with Cloudflare only enabled.** A site with that
setting off is not restricted by this protection. Enabling bypass protection
does not turn Cloudflare-only access on for other sites.

Cloudflare must connect directly to Nginx. If a load balancer or tunnel sits
between them, switch this protection off until that setup has its own access
check. Direct certificate validation requests are blocked too; use validation
through Cloudflare or DNS.

**Protection configured** means the check is present in the Nginx files.
If it needs repair, run `clp-addons repair` and check the reported error.
CloudPanel replacing its IP list triggers repair automatically, but until repair
finishes only CloudPanel's original rules may be active.

Switching protection off or disabling the addon removes the added check and
leaves CloudPanel's rules in place. Re-enabling the addon restores your saved
choice. Changes to System Tweaks do not affect this protection.
