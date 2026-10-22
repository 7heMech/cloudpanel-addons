import { esc, htmlResponse, SECURITY_HEADERS } from "../../../lib/app-http";
import { renderToolWindow } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";

/**
 * The page a sign-in's window opens on. Its policy lets a form go to this one
 * site, so the addon's page can refuse every form: a policy there listing every
 * site outgrew the 4 KiB response header the panel's Nginx buffers.
 */
export function signInWindow(domain: string): Response {
  const policy = SECURITY_HEADERS["Content-Security-Policy"]!.replace("form-action 'none'", `form-action https://${domain}`);
  const page = renderToolWindow(`Signing in to ${domain}`, `<p class="empty">Signing in to ${esc(domain)}…</p>`, {
    base: mountPath("wp-login"),
    script: "",
  });
  return htmlResponse(page, { headers: { "Content-Security-Policy": policy } });
}
