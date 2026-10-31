// Every verb `clp-addons action php-resources` takes, and who may ask root for it from the web.
export const PHP_RESOURCES_VERBS = {
  list: { web: "admin" },
  site: { web: "admin" },
  "save-category": { web: "admin" },
  "delete-category": { web: "admin" },
  assign: { web: "admin" },
  "set-default": { web: "admin" },
  reconcile: { web: false, why: "walks the whole fleet; run in-process by the new-site watcher and repair" },
} as const;
