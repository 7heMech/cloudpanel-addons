// Every verb `clp-addons action firewall` takes, and who may ask root for it from the web.
// `lock` marks the protections `clp-addons lock firewall` holds: while locked, the web may
// only switch them on, and cannot disable the addon.
export const FIREWALL_VERBS = {
  list: { web: "admin" },
  set: { web: "admin" },
  policy: { web: "admin" },
  "set-visitor-ip": { web: "admin", lock: "on" },
  reconcile: { web: false, why: "run by hand; the new-site watcher and repair run the same pass in-process" },
  protocols: { web: "admin" },
  "set-protocol": { web: "admin" },
  "set-protocols": { web: "admin" },
  "hetzner-connect": { web: "admin" },
  "hetzner-disconnect": { web: "admin" },
  "hetzner-switch": { web: "admin" },
  "netcup-connect": { web: "admin" },
  "netcup-poll": { web: "admin" },
  "netcup-disconnect": { web: "admin" },
  "netcup-switch": { web: "admin" },
  "panel-gate": { web: "admin" },
  "panel-gate-switch": { web: "admin" },
  "panel-gate-cleanup": { web: false, why: "run by disable for what Cloudflare still has of the gate; repair does the same in-process" },
  "edge-check": { web: "admin" },
  "edge-save": { web: "admin" },
  "edge-confirm": { web: "admin" },
  "edge-review-zone": { web: "admin" },
  "edge-zone-choice": { web: "admin" },
} as const;
