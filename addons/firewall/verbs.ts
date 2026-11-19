// Every verb `clp-addons action firewall` takes, and who may ask root for it from the web.
export const FIREWALL_VERBS = {
  list: { web: "admin" },
  set: { web: "admin" },
  policy: { web: "admin" },
  reconcile: { web: false, why: "run by hand; the new-site watcher and repair run the same pass in-process" },
  protocols: { web: "admin" },
  "set-protocol": { web: "admin" },
  "set-protocols": { web: "admin" },
  "hetzner-connect": { web: "admin" },
  "hetzner-disconnect": { web: "admin" },
  "hetzner-switch": { web: "admin" },
  "panel-gate": { web: "admin" },
  "panel-gate-switch": { web: "admin" },
  "panel-gate-cleanup": { web: false, why: "run by disable for what Cloudflare still has of the gate; repair does the same in-process" },
} as const;
