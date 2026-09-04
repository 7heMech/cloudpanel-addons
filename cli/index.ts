import { existsSync, copyFileSync, chmodSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { injectAll, removeAll, isTemplateInjected, HEADER_TEMPLATE, NEW_SITE_TEMPLATE } from "../addons/instatic/inject/template-manager";
import { generateSnapshot, getNextAvailablePort, SNAPSHOT_FILE } from "../lib/snapshot";

const VERSION = "0.1.0";

const WRAPPER_TARGET = "/usr/local/lib/clp-addons/clp-action-instatic";
const APP_TARGET = "/usr/local/bin/clp-addon-instatic-app";
const SUDOERS_FILE = "/etc/sudoers.d/clp-addon-instatic";
const PANEL_NGINX_CONF = "/home/clp/services/nginx/sites-enabled/cloudpanel.conf";

const UNIT_SERVICE = `[Unit]
Description=CloudPanel Addon - Instatic Manager Service
After=network.target docker.service clp-nginx.service
Wants=docker.service

[Service]
Type=simple
User=instatic-app
Group=instatic-app
Environment=PORT=39001
Environment=HOST=127.0.0.1
Environment=INSTATIC_APP_DATA=/var/lib/clp-addons/instatic
Environment=INSTATIC_WRAPPER=/usr/local/lib/clp-addons/clp-action-instatic
ExecStart=/usr/local/bin/clp-addon-instatic-app
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`;

const UNIT_RECONCILE_SERVICE = `[Unit]
Description=CloudPanel Addons - Template & State Reconciliation
After=network.target clp-nginx.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/clp-addons repair

[Install]
WantedBy=multi-user.target
`;

const UNIT_RECONCILE_TIMER = `[Unit]
Description=CloudPanel Addons - Periodic Template Reconciliation Timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
`;

function log(msg: string) {
  console.log(`[clp-addons] ${msg}`);
}

function error(msg: string) {
  console.error(`[clp-addons:error] ${msg}`);
}

function checkRoot() {
  if (process.getuid && process.getuid() !== 0) {
    error("This command requires root privileges. Please run with sudo or as root.");
    process.exit(1);
  }
}

async function cmdStatus() {
  console.log(`=== CloudPanel Addons Status (v${VERSION}) ===\n`);

  // 1. Docker Status
  try {
    const dOut = execSync("docker --version", { encoding: "utf-8" }).trim();
    const dActive = execSync("systemctl is-active docker", { encoding: "utf-8" }).trim();
    console.log(`Docker:             ${dOut} (${dActive})`);
  } catch {
    console.log(`Docker:             NOT INSTALLED or INACTIVE`);
  }

  // 2. Service Status
  try {
    const sActive = execSync("systemctl is-active clp-addon-instatic.service 2>/dev/null || echo inactive", { encoding: "utf-8" }).trim();
    console.log(`Instatic Service:   ${sActive}`);
  } catch {
    console.log(`Instatic Service:   inactive`);
  }

  // 3. Wrapper
  const wrapperOk = existsSync(WRAPPER_TARGET);
  console.log(`Wrapper Installed:  ${wrapperOk ? "YES (" + WRAPPER_TARGET + ")" : "NO"}`);

  // 4. Template Injections
  const headerInjected = isTemplateInjected(HEADER_TEMPLATE);
  const newSiteInjected = isTemplateInjected(NEW_SITE_TEMPLATE);
  console.log(`Header Nav Anchor:  ${headerInjected ? "INJECTED" : "MISSING"}`);
  console.log(`New Site Button:    ${newSiteInjected ? "INJECTED" : "MISSING"}`);

  // 5. Next available port
  try {
    const nextPort = getNextAvailablePort();
    console.log(`Next Port:          ${nextPort}`);
  } catch (err: any) {
    console.log(`Next Port:          Error: ${err.message}`);
  }

  // 6. Active Containers
  try {
    const containers = execSync("docker ps --filter 'name=instatic-' --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'", { encoding: "utf-8" }).trim();
    console.log("\n--- Active Instatic Containers ---");
    if (containers) {
      console.log(containers);
    } else {
      console.log("No instatic containers currently running.");
    }
  } catch {}
  console.log("\n============================================");
}

async function cmdRepair() {
  checkRoot();
  log("Running repair and reconciliation...");

  // 1. Template check & re-injection
  const headerOk = isTemplateInjected(HEADER_TEMPLATE);
  const newSiteOk = isTemplateInjected(NEW_SITE_TEMPLATE);

  if (!headerOk || !newSiteOk) {
    log("Templates missing markers. Re-injecting...");
    injectAll();
  } else {
    log("Templates already have active anchors.");
  }

  // 2. Snapshot refresh
  log("Refreshing panel state snapshot...");
  generateSnapshot();

  // 3. Systemd service health
  try {
    const sActive = execSync("systemctl is-active clp-addon-instatic.service", { encoding: "utf-8" }).trim();
    if (sActive !== "active") {
      log("Restarting inactive clp-addon-instatic.service...");
      execSync("systemctl restart clp-addon-instatic.service");
    }
  } catch {
    log("Starting clp-addon-instatic.service...");
    try {
      execSync("systemctl restart clp-addon-instatic.service");
    } catch {}
  }

  log("Repair completed successfully.");
}

async function cmdInstall(addon: string) {
  checkRoot();
  if (addon !== "instatic") {
    error(`Unknown addon: ${addon}. Permitted addons: instatic`);
    process.exit(1);
  }

  log("Starting installation of Instatic addon...");

  // 1. Verify Docker
  try {
    execSync("systemctl is-active docker");
  } catch {
    error("Docker service is not active. Please install and start docker first.");
    process.exit(1);
  }

  // 2. Ensure instatic-app user exists
  try {
    execSync("id -u instatic-app 2>/dev/null");
    log("User instatic-app already exists.");
  } catch {
    log("Creating system user instatic-app...");
    execSync("useradd -r -s /usr/sbin/nologin -d /var/lib/clp-addons/instatic -M instatic-app");
  }

  // Add instatic-app to docker group
  try {
    execSync("usermod -aG docker instatic-app");
  } catch {}

  // 3. Create required directories
  mkdirSync("/usr/local/lib/clp-addons", { recursive: true });
  mkdirSync("/var/lib/clp-addons/instatic", { recursive: true });
  mkdirSync("/run/lock/clp-addons", { recursive: true });
  mkdirSync("/etc/clp-addons", { recursive: true });
  execSync("chown -R instatic-app:instatic-app /var/lib/clp-addons/instatic");
  execSync("chmod 750 /var/lib/clp-addons/instatic");

  // 4. Install wrapper
  log(`Installing privileged wrapper to ${WRAPPER_TARGET}...`);
  const wrapperSrc = "/root/cloudpanel-addons/addons/instatic/wrapper/clp-action-instatic";
  if (existsSync(wrapperSrc)) {
    copyFileSync(wrapperSrc, WRAPPER_TARGET);
  }
  execSync(`chown root:root "${WRAPPER_TARGET}"`);
  execSync(`chmod 755 "${WRAPPER_TARGET}"`);

  // 5. Configure sudoers
  log(`Configuring sudoers drop-in at ${SUDOERS_FILE}...`);
  const sudoersContent = `# CloudPanel Addon: Instatic privilege separation\ninstatic-app ALL=(ALL) NOPASSWD: ${WRAPPER_TARGET}, /usr/bin/clpctlWrapper\n`;
  writeFileSync(SUDOERS_FILE, sudoersContent, { mode: 0o440 });
  try {
    execSync("visudo -c");
    log("Sudoers configuration verified cleanly.");
  } catch (err: any) {
    rmSync(SUDOERS_FILE, { force: true });
    error("Sudoers validation failed! Removed drop-in.");
    process.exit(1);
  }

  // 6. Build and copy compiled app binary
  log("Building and placing compiled app binary...");
  const compiledAppSrc = "/root/cloudpanel-addons/dist/clp-addon-instatic-app";
  if (!existsSync(compiledAppSrc)) {
    execSync("cd /root/cloudpanel-addons && bun build --compile --target=bun-linux-x64 --outfile dist/clp-addon-instatic-app addons/instatic/app/server.ts");
  }
  copyFileSync(compiledAppSrc, APP_TARGET);
  execSync(`chmod 755 "${APP_TARGET}"`);

  // 7. Install systemd units
  log("Installing systemd units and reconciliation timer...");
  writeFileSync("/etc/systemd/system/clp-addon-instatic.service", UNIT_SERVICE, "utf-8");
  writeFileSync("/etc/systemd/system/clp-addons-reconcile.service", UNIT_RECONCILE_SERVICE, "utf-8");
  writeFileSync("/etc/systemd/system/clp-addons-reconcile.timer", UNIT_RECONCILE_TIMER, "utf-8");

  execSync("systemctl daemon-reload");
  execSync("systemctl enable --now clp-addon-instatic.service");
  execSync("systemctl enable --now clp-addons-reconcile.timer");
  log("Services enabled and started.");

  // 8. Configure panel reverse proxy location in panel nginx
  try {
    if (existsSync(PANEL_NGINX_CONF)) {
      let pConf = readFileSync(PANEL_NGINX_CONF, "utf-8");
      if (!pConf.includes("/instatic/")) {
        log("Adding /instatic/ reverse proxy route to CloudPanel nginx...");
        const proxyBlock = `
  location /instatic/ {
    proxy_pass http://127.0.0.1:39001/instatic/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
`;
        pConf = pConf.replace("location ~ /.well-known {", `${proxyBlock}\n  location ~ /.well-known {`);
        writeFileSync(PANEL_NGINX_CONF, pConf, "utf-8");
        execSync("/usr/sbin/nginx -t -c /home/clp/services/nginx/nginx.conf");
        execSync("systemctl reload clp-nginx");
        log("CloudPanel nginx reloaded with /instatic/ route.");
      }
    }
  } catch (err: any) {
    log(`[WARN] CloudPanel nginx integration note: ${err.message}`);
  }

  // 9. Inject templates and purge cache
  log("Injecting UI anchors into CloudPanel Twig templates...");
  injectAll();

  // 10. Generate state snapshot
  log("Generating initial snapshot...");
  generateSnapshot();

  log("Instatic Addon successfully installed!");
  log("Access Instatic at https://<your-panel-ip>:8443/instatic/ or via the top nav in CloudPanel.");
}

async function cmdUninstall(addon: string) {
  checkRoot();
  if (addon !== "instatic") {
    error(`Unknown addon: ${addon}`);
    process.exit(1);
  }

  log("Uninstalling Instatic addon...");

  // 1. Stop and disable systemd services
  try {
    execSync("systemctl disable --now clp-addon-instatic.service 2>/dev/null || true");
    execSync("systemctl disable --now clp-addons-reconcile.timer 2>/dev/null || true");
    rmSync("/etc/systemd/system/clp-addon-instatic.service", { force: true });
    rmSync("/etc/systemd/system/clp-addons-reconcile.service", { force: true });
    rmSync("/etc/systemd/system/clp-addons-reconcile.timer", { force: true });
    execSync("systemctl daemon-reload");
  } catch {}

  // 2. Remove sudoers drop-in
  rmSync(SUDOERS_FILE, { force: true });

  // 3. Remove templates injection
  removeAll();

  // 4. Remove binaries
  rmSync(APP_TARGET, { force: true });
  rmSync(WRAPPER_TARGET, { force: true });

  log("Instatic addon uninstalled.");
}

// --- CLI Entry Point ---

const args = process.argv.slice(2);
const verb = args[0] || "help";

switch (verb) {
  case "--version":
  case "-v":
    console.log(`clp-addons v${VERSION}`);
    break;

  case "status":
    await cmdStatus();
    break;

  case "repair":
    await cmdRepair();
    break;

  case "snapshot":
    checkRoot();
    generateSnapshot();
    log(`Snapshot written to ${SNAPSHOT_FILE}`);
    break;

  case "install":
    await cmdInstall(args[1] || "instatic");
    break;

  case "uninstall":
    await cmdUninstall(args[1] || "instatic");
    break;

  case "help":
  default:
    console.log(`
CloudPanel Addons CLI (v${VERSION})

Usage:
  clp-addons status               Show system & addon status
  clp-addons install [addon]      Install an addon (e.g. instatic)
  clp-addons uninstall [addon]    Uninstall an addon
  clp-addons repair               Reconcile templates, snapshot, & services
  clp-addons snapshot             Regenerate panel state snapshot
  clp-addons --version            Display version
`);
    break;
}
