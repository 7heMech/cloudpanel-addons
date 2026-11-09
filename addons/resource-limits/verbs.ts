// Every verb `clp-addons action resource-limits` takes, and who may ask root for it from the web.
export const RESOURCE_LIMITS_VERBS = {
  "set-memory": { web: "admin" },
  "restart-mysql": { web: "admin" },
  list: { web: "admin" },
  site: { web: "admin" },
  "save-category": { web: "admin" },
  "delete-category": { web: "admin" },
  assign: { web: "admin" },
  "set-default": { web: "admin" },
  reconcile: { web: false, why: "walks the whole fleet; run in-process by the new-site watcher and repair" },
} as const;
