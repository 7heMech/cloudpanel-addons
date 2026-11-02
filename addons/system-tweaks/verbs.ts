// Every verb `clp-addons action system-tweaks` takes, and who may ask root for it from the web.
// `install-updates` installs one fixed package; no verb takes a package name, a path or an apt option.
export const SYSTEM_TWEAKS_VERBS = {
  state: { web: "admin" },
  "set-updates": { web: "admin" },
  "install-updates": { web: "admin" },
  "set-upload-guard": { web: "admin" },
  "set-real-ip": { web: "admin" },
  "set-panel-php": { web: "admin" },
  firewall: { web: "admin" },
  "set-firewall-protocol": { web: "admin" },
} as const;
