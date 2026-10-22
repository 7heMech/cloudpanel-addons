export function appRequest(path: string, method = "GET", body?: unknown, guarded = true): Request {
  return new Request("https://panel.test" + path, {
    method,
    headers: guarded ? {
      Host: "panel.test", Origin: "https://panel.test", Cookie: "clp_addons_csrf=token",
      "X-CLP-Addons-CSRF": "token", "Content-Type": "application/json",
    } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
