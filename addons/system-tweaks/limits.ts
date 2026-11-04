// Shared by the root action and the manager, so it imports nothing.

/** A hung apt-get's guard; `DPkg::Lock::Timeout` is 120 s of it. */
export const APT_STEP_MS = 280_000;
/** A hung query's guard: dpkg-query, apt-config, apt-cache, systemctl. */
export const COMMAND_MS = 30_000;
/** Everything `install-updates` does, including the state read its reply carries. */
export const INSTALL_DEADLINE_MS = 600_000;
/** The gateway kills the action at this, so it waits past the deadline for start-up and the reply. */
export const INSTALL_GATEWAY_TIMEOUT_MS = INSTALL_DEADLINE_MS + 30_000;
/** A config test, a restart, up to 20 s for the panel to answer, and the same again to undo it. */
export const PANEL_PHP_GATEWAY_TIMEOUT_MS = 90_000;
/** Lock waiting, an FPM config test and reload, 20 s for the panel to answer, and the reload that undoes it. */
export const POOL_GUARD_GATEWAY_TIMEOUT_MS = 90_000 + 4 * COMMAND_MS;
/** A daemon-reload, the nft checks and load, lock waiting and the reply. */
export const PHP_POOLS_GATEWAY_TIMEOUT_MS = 4 * COMMAND_MS + 30_000;
/** Nginx validation and reload, a rollback of both, lock waiting and the reply; phpMyAdmin's switch uses it too. */
export const REAL_IP_GATEWAY_TIMEOUT_MS = 4 * COMMAND_MS + 60_000;
/** The panel nginx's test and reload and their rollback, a fail2ban config test and reload, and the reply. */
export const LOGIN_JAILS_GATEWAY_TIMEOUT_MS = 6 * COMMAND_MS + 30_000;
/** Generating a key pair, Nginx validation and reload, a rollback of both, lock waiting and the reply. */
export const PANEL_CERT_GATEWAY_TIMEOUT_MS = 5 * COMMAND_MS + 60_000;
