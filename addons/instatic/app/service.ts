import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { instanceRepo, type InstanceRecord } from "./db";
import { getNextAvailablePort, generateSnapshot } from "../../../lib/snapshot";

const execFileAsync = promisify(execFile);

const WRAPPER_BIN = process.env.INSTATIC_WRAPPER || "/usr/local/lib/clp-addons/clp-action-instatic";
const CLPCTL_WRAPPER = "/usr/bin/clpctlWrapper";

export interface WrapperResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function runWrapper(args: string[]): Promise<WrapperResponse> {
  try {
    const isRoot = process.getuid ? process.getuid() === 0 : false;
    const cmd = isRoot ? WRAPPER_BIN : "sudo";
    const cmdArgs = isRoot ? args : [WRAPPER_BIN, ...args];

    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, { timeout: 120000 });
    if (stderr) console.error("[wrapper stderr]:", stderr);
    return JSON.parse(stdout.trim());
  } catch (err: any) {
    console.error("[wrapper exec error]:", err);
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout.trim());
      } catch {
        // Fallback
      }
    }
    return { ok: false, error: err.stderr || err.message };
  }
}

export const instaticService = {
  getAvailableTags(): string[] {
    return [
      "0.0.18",
      "0.0.17",
      "0.0.16",
      "0.0.15",
      "0.0.14",
      "0.0.13",
      "0.0.12",
      "0.0.11",
      "0.0.10"
    ];
  },

  getNextPort(): number {
    return getNextAvailablePort(39000, 39999);
  },

  async listInstances(): Promise<InstanceRecord[]> {
    const records = instanceRepo.getAll();
    // Refresh live status for records
    for (const r of records) {
      try {
        const { stdout } = await execFileAsync("docker", [
          "inspect",
          "-f",
          "{{.State.Status}}",
          r.container_name
        ]);
        const liveStatus = stdout.trim();
        if (liveStatus && liveStatus !== r.status) {
          r.status = liveStatus;
          instanceRepo.updateStatus(r.domain, liveStatus);
        }
      } catch {
        // Container might not be running or stopped
        if (r.status === "running") {
          r.status = "stopped";
          instanceRepo.updateStatus(r.domain, "stopped");
        }
      }
    }
    return records;
  },

  async createInstance(params: {
    domain: string;
    tag: string;
    siteUser?: string;
    siteUserPassword?: string;
  }): Promise<WrapperResponse> {
    const { domain, tag } = params;
    const existing = instanceRepo.getByDomain(domain);
    if (existing) {
      return { ok: false, error: `Instance with domain ${domain} already exists in registry.` };
    }

    const port = this.getNextPort();
    const siteUser = params.siteUser || `inst_${domain.replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
    const sitePass = params.siteUserPassword || `Pass_${Math.random().toString(36).slice(2, 10)}!1A`;

    // 1. Create CloudPanel Reverse Proxy site
    console.log(`[INFO] Creating CloudPanel reverse-proxy site for ${domain} -> 127.0.0.1:${port}...`);
    try {
      const isRoot = process.getuid ? process.getuid() === 0 : false;
      const clpCmd = isRoot ? CLPCTL_WRAPPER : "sudo";
      const clpArgs = isRoot
        ? [
            "site:add:reverse-proxy",
            `--domainName=${domain}`,
            `--reverseProxyUrl=http://127.0.0.1:${port}`,
            `--siteUser=${siteUser}`,
            `--siteUserPassword=${sitePass}`
          ]
        : [
            CLPCTL_WRAPPER,
            "site:add:reverse-proxy",
            `--domainName=${domain}`,
            `--reverseProxyUrl=http://127.0.0.1:${port}`,
            `--siteUser=${siteUser}`,
            `--siteUserPassword=${sitePass}`
          ];

      await execFileAsync(clpCmd, clpArgs, { timeout: 60000 });
      console.log(`[INFO] CloudPanel site ${domain} created successfully.`);
    } catch (err: any) {
      console.error("[ERROR] Failed creating CloudPanel site:", err);
      return { ok: false, error: `Failed creating CloudPanel reverse proxy: ${err.message}` };
    }

    // 2. Launch container via wrapper
    console.log(`[INFO] Launching Instatic container for ${domain} on port ${port}...`);
    const wrapperRes = await runWrapper([
      "create",
      "--domain",
      domain,
      "--port",
      String(port),
      "--tag",
      tag
    ]);

    if (!wrapperRes.ok) {
      // Rollback CloudPanel site
      try {
        await execFileAsync(
          process.getuid && process.getuid() === 0 ? CLPCTL_WRAPPER : "sudo",
          [CLPCTL_WRAPPER, "site:delete", `--domainName=${domain}`]
        );
      } catch (cleanupErr) {
        console.error("[WARN] Failed rolling back CloudPanel site:", cleanupErr);
      }
      return wrapperRes;
    }

    // 3. Record in local DB
    const now = new Date().toISOString();
    instanceRepo.insert({
      domain,
      port,
      tag,
      container_name: `instatic-${domain}`,
      site_user: siteUser,
      status: "running",
      created_at: now,
      updated_at: now
    });

    // 4. Refresh snapshot
    try {
      generateSnapshot();
    } catch {}

    return wrapperRes;
  },

  async updateInstance(domain: string, tag: string): Promise<WrapperResponse> {
    const res = await runWrapper(["update", "--domain", domain, "--tag", tag]);
    if (res.ok) {
      instanceRepo.updateTag(domain, tag);
    }
    return res;
  },

  async startInstance(domain: string): Promise<WrapperResponse> {
    const res = await runWrapper(["start", "--domain", domain]);
    if (res.ok) instanceRepo.updateStatus(domain, "running");
    return res;
  },

  async stopInstance(domain: string): Promise<WrapperResponse> {
    const res = await runWrapper(["stop", "--domain", domain]);
    if (res.ok) instanceRepo.updateStatus(domain, "stopped");
    return res;
  },

  async restartInstance(domain: string): Promise<WrapperResponse> {
    const res = await runWrapper(["restart", "--domain", domain]);
    if (res.ok) instanceRepo.updateStatus(domain, "running");
    return res;
  },

  async deleteInstance(domain: string): Promise<WrapperResponse> {
    // 1. Delete container & data via wrapper
    const res = await runWrapper(["delete", "--domain", domain, "--confirm", domain]);
    if (!res.ok) return res;

    // 2. Delete CloudPanel site
    try {
      const isRoot = process.getuid ? process.getuid() === 0 : false;
      const cmd = isRoot ? CLPCTL_WRAPPER : "sudo";
      const args = isRoot
        ? ["site:delete", `--domainName=${domain}`]
        : [CLPCTL_WRAPPER, "site:delete", `--domainName=${domain}`];
      await execFileAsync(cmd, args, { timeout: 60000 });
    } catch (err) {
      console.warn(`[WARN] Site delete in CloudPanel encountered issue for ${domain}:`, err);
    }

    // 3. Remove from local DB & refresh snapshot
    instanceRepo.delete(domain);
    try {
      generateSnapshot();
    } catch {}

    return res;
  },

  async snapshotInstance(domain: string): Promise<WrapperResponse> {
    return runWrapper(["snapshot", "--domain", domain]);
  },

  async getLogs(domain: string, lines = 100): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync("docker", [
        "logs",
        "--tail",
        String(lines),
        `instatic-${domain}`
      ]);
      return stdout + (stderr ? `\n${stderr}` : "");
    } catch (err: any) {
      return `Failed to fetch logs: ${err.message}`;
    }
  }
};
