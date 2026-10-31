// Every verb `clp-addons action dns` takes, and who may ask root for it from the web.
export const DNS_VERBS = {
  list: { web: "admin" },
  check: { web: "admin" },
  "save-profile": { web: "admin" },
  "delete-profile": { web: "admin" },
  "set-automatic": { web: "admin" },
  "zone-account": { web: "admin" },
  assign: { web: "admin" },
  "set-default": { web: "admin" },
  confirm: { web: "admin" },
  "save-connection": { web: "admin" },
  "remove-connection": { web: "admin" },
  "choose-zone": { web: "admin" },
  "save-mailcow": { web: "admin" },
  "remove-mailcow": { web: "admin" },
  "save-server": { web: "admin" },
  "remove-records": { web: "admin" },
  "forget-records": { web: "admin" },
  "save-redirect": { web: "admin" },
  "delete-redirect": { web: "admin" },
  "find-redirects": { web: "admin" },
  "take-over": { web: "admin" },
  // Called from the page a new site lands on and from its SSL/TLS page, by
  // whoever can open it; a non-administrator is named with --as-user and held
  // to their own sites.
  provision: { web: "panel-user" },
  "site-status": { web: "panel-user" },
  reconcile: { web: false, why: "the full check, run by the worker repair queues" },
  "sync-sites": { web: false, why: "run by the new-site watcher" },
} as const;
