import { csrfCookieHeader, esc, newCsrfToken, SECURITY_HEADERS } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";

const BASE = mountPath("login-theme");

function page(content: string, csrf: string, status = 200, updateNotice?: { current: string; latest: string } | null): Response {
  return new Response(
    renderLayout("Login theme", content, {
      brand: "Login theme",
      base: BASE,
      nav: [],
      script: "",
      updateNotice,
    }),
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": csrfCookieHeader(csrf),
        ...SECURITY_HEADERS,
      },
    },
  );
}

/**
 * The login-theme addon has no daemon or mutable API. This small page gives it
 * a normal manager mount so the bundled addon follows the same navigation and
 * enable/disable lifecycle as the feature addons.
 */
export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  if (req.method !== "GET") {
    return page('<div class="alert" role="alert">This addon does not accept changes from this page.</div>', newCsrfToken(), 405, updateNotice);
  }
  if (path !== "/") {
    return page(`<div class="alert" role="alert">${esc("Page not found")}</div>`, newCsrfToken(), 404, updateNotice);
  }
  return page(`
    <div class="form-page">
      <div class="page-heading">
        <div><h1>Login theme</h1><p>Follow the browser or operating system's light/dark preference.</p></div>
      </div>
      <div class="card">
        <div class="card-header"><h2>Device theme enabled</h2></div>
        <p>The first time a browser reaches the CloudPanel login page, the panel's theme is set from that device's light or dark preference. From then on the theme switch in the header owns the setting, exactly as it does without this addon.</p>
        <p class="hint">This addon adds no styling of its own: it uses CloudPanel's dark-mode stylesheet and writes the same theme cookie the panel's own switch writes.</p>
        <a class="btn btn-primary" href="/addons/">Back to Addons</a>
      </div>
    </div>`, newCsrfToken(), 200, updateNotice);
}
