// Every verb `clp-addons action redirects` takes, and who may ask root for it from the web.
export const REDIRECTS_VERBS = {
  list: { web: "admin" },
  check: { web: "admin" },
  "set-automatic": { web: "admin" },
  "save-redirect": { web: "admin" },
  "delete-redirect": { web: "admin" },
  "review-redirect": { web: "admin" },
  confirm: { web: "admin" },
  "find-redirects": { web: "admin" },
  "take-over": { web: "admin" },
  "choose-zone": { web: "admin" },
  "save-connection": { web: "admin" },
  "remove-connection": { web: "admin" },
  "create-site-helper": { web: "admin" },
  reconcile: { web: false, why: "the full check, run by the worker repair queues" },
  "sync-sites": { web: false, why: "run by the new-sites watcher when CloudPanel creates a site" },
} as const;
