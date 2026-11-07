// Every verb `clp-addons action system-tweaks` takes, and who may ask root for it from the web.
// `install-updates` installs one fixed package; no verb takes a package name, a path or an apt option.
// `lock` marks the protections `clp-addons lock system-tweaks` takes from the web.
export const SYSTEM_TWEAKS_VERBS = {
  state: { web: "admin" },
  "set-updates": { web: "admin" },
  "install-updates": { web: "admin" },
  "set-upload-guard": { web: "admin", lock: true },
  "set-real-ip": { web: "admin", lock: true },
  "set-panel-cert": { web: "admin", lock: true },
  "set-vhost-guard": { web: "admin", lock: true },
  "set-phpmyadmin": { web: "admin", lock: true },
  "set-file-manager-guard": { web: "admin", lock: true },
  "set-clpctl-guard": { web: "admin", lock: true },
  "set-backup-compression": { web: "admin" },
  "set-telemetry": { web: "admin", lock: true },
  "set-motd": { web: "admin" },
  "set-panel-php": { web: "admin", lock: true },
  "set-php-pools": { web: "admin", lock: true },
  "set-login-jails": { web: "admin", lock: true },
  "install-fail2ban": { web: "admin" },
  unban: { web: "admin" },
  "set-database-loopback": { web: "admin", lock: true },
  firewall: { web: "admin" },
  "set-firewall-protocol": { web: "admin" },
} as const;
