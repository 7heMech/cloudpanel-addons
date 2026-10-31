// Every verb `clp-addons action cloudflare-ips` takes, and who may ask root for it from the web.
export const CLOUDFLARE_IPS_VERBS = {
  list: { web: "admin" },
  set: { web: "admin" },
  policy: { web: "admin" },
  reconcile: { web: false, why: "run by hand; the new-site watcher and repair run the same pass in-process" },
} as const;
