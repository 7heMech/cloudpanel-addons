// Every verb `clp-addons action smtp` takes, and who may ask root for it from the web.
export const SMTP_VERBS = {
  list: { web: "admin" },
  "save-profile": { web: "admin" },
  "delete-profile": { web: "admin" },
  assign: { web: "admin" },
  "set-default": { web: "admin" },
  "save-grants": { web: "admin" },
  test: { web: "admin" },
  reconcile: { web: false, why: "run by repair and on enable" },
  "sync-sites": { web: false, why: "run by the new-site watcher" },
  deactivate: { web: false, why: "run locally during disable or uninstall" },
} as const;
