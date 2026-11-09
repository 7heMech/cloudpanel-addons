// Every verb `clp-addons action firewall` takes, and who may ask root for it from the web.
export const FIREWALL_VERBS = {
  list: { web: "admin" },
  set: { web: "admin" },
  policy: { web: "admin" },
  reconcile: { web: false, why: "run by hand; the new-site watcher and repair run the same pass in-process" },
  protocols: { web: "admin" },
  "set-protocol": { web: "admin" },
  "set-protocols": { web: "admin" },
} as const;
