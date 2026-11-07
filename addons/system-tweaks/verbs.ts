// Every verb `clp-addons action system-tweaks` takes, and who may ask root for it from the web.
// `install-updates` installs one fixed package; no verb takes a package name, a path or an apt option.
// `lock` marks the protections `clp-addons lock system-tweaks` holds: while locked, the web may
// only switch them on, and move the panel's PHP only to a newer version.
// `lock-settings` switches every `"on"` protection on and then locks.
export const SYSTEM_TWEAKS_VERBS = {
  state: { web: "admin" },
  "set-updates": { web: "admin" },
  "install-updates": { web: "admin" },
  "set-upload-guard": { web: "admin", lock: "on" },
  "set-real-ip": { web: "admin", lock: "on" },
  "set-panel-cert": { web: "admin", lock: "on" },
  "set-vhost-guard": { web: "admin", lock: "on" },
  "set-phpmyadmin": { web: "admin", lock: "on" },
  "set-file-manager-guard": { web: "admin", lock: "on" },
  "set-clpctl-guard": { web: "admin", lock: "on" },
  "set-backup-compression": { web: "admin" },
  "set-telemetry": { web: "admin", lock: "on" },
  "set-motd": { web: "admin" },
  "set-panel-php": { web: "admin", lock: "newer" },
  "set-php-pools": { web: "admin", lock: "on" },
  "set-login-jails": { web: "admin", lock: "on" },
  "install-fail2ban": { web: "admin" },
  unban: { web: "admin" },
  "set-database-loopback": { web: "admin", lock: "on" },
  "lock-settings": { web: "admin" },
  firewall: { web: "admin" },
  "set-firewall-protocol": { web: "admin" },
} as const;
