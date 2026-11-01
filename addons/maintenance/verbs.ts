// Every verb `clp-addons action maintenance` takes, and who may ask root for it from the web.
export const MAINTENANCE_VERBS = {
  sites: { web: "admin" },
  "enable-many": { web: "admin" },
  "disable-many": { web: "admin" },
  status: { web: "admin" },
  enable: { web: "admin" },
  disable: { web: "admin" },
  "get-template": { web: "admin" },
  "set-template": { web: "admin" },
  "reset-template": { web: "admin" },
  "set-bypass": { web: "admin" },
  "global-status": { web: "admin" },
  "global-enable": { web: "admin" },
  "global-disable": { web: "admin" },
  "global-set-bypass": { web: "admin" },
} as const;
