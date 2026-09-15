import { esc, newCsrfToken, withCsrfCookie, SECURITY_HEADERS } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";

const BASE = mountPath("login-theme");

/** Wraps login-theme content in the shared manager page and response headers. */
function page(content: string, csrf: string, status = 200, updateNotice?: { current: string; latest: string } | null): Response {
  return new Response(
    renderLayout("Device theme on first visit", content, {
      brand: "Device theme on first visit",
      base: BASE,
      nav: [],
      script: "",
      updateNotice,
    }),
    {
      status,
      headers: withCsrfCookie({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS,
      }, csrf),
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
        <div><h1>Device theme on first visit</h1><p>Use this device's light or dark preference as the initial CloudPanel theme.</p></div>
      </div>
      <div class="card">
        <div class="card-header"><h2>Enabled</h2></div>
        <p>On the first visit to the CloudPanel login page, the theme follows this device's preference. After that, CloudPanel keeps the theme selected with its own switch.</p>
        <p class="hint">The addon uses CloudPanel's built-in light and dark themes.</p>
        <a class="btn btn-primary" href="/addons/">Back to Addons</a>
      </div>
    </div>`, newCsrfToken(), 200, updateNotice);
}
