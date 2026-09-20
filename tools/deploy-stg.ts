// Builds the binary and installs it on the staging CloudPanel box.
//
// Most of the 85 MB compiled binary is the same Bun runtime every time, so
// rsync sends only the blocks that changed, over one multiplexed SSH
// connection. The swap is a rename, which the running services do not block:
// they go on serving the old binary from the replaced inode until they are
// restarted, so the restart is part of the install and not left to repair.
//
//   bun tools/deploy-stg.ts
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.STG_HOST || "root@46.225.93.37";
const key = process.env.STG_KEY || join(homedir(), ".ssh/cloudpanel-addons-dev-0bad61aa9144");
// A workstation already knows this box; a CI runner does not, and learning the
// host key on connection would let anything answering that address receive a
// root command sequence. STG_KNOWN_HOSTS pins it instead.
const knownHosts = process.env.STG_KNOWN_HOSTS;
const controlDir = mkdtempSync(join(tmpdir(), "clp-deploy-"));
const sshOptions = [
  "-o", "BatchMode=yes",
  ...(knownHosts ? ["-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes"] : []),
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${join(controlDir, "s")}`,
  "-o", "ControlPersist=60",
  "-i", key,
];

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: repo, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

const shellQuote = (parts: string[]) => parts.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");

try {
  // The connection is opened while the build runs, so the upload starts on an
  // authenticated channel instead of paying a handshake of its own.
  const connected = run(["ssh", ...sshOptions, host, "true"]);
  await run(["bun", "run", "build"]);
  await connected;
  const binary = join(repo, "dist/clp-addons-linux-x64");
  // rsync verifies the reconstructed file, so a partial upload cannot be
  // installed as if it were whole. Somewhere without it still deploys, whole.
  await run(Bun.which("rsync")
    ? ["rsync", "--inplace", "-e", shellQuote(["ssh", ...sshOptions]), binary, `${host}:/root/clp-addons-new`]
    : ["scp", ...sshOptions, binary, `${host}:/root/clp-addons-new`]);
  await run(["ssh", ...sshOptions, host, [
    "set -e",
    "install -m 0755 -o root -g root /root/clp-addons-new /usr/local/bin/.clp-addons.new",
    // The swap below is the last moment the binary the box is running can be
    // named, and on a first deploy it is kept nowhere else.
    "if [ -e /usr/local/bin/clp-addons ]; then ln -f /usr/local/bin/clp-addons /root/clp-addons-previous; else rm -f /root/clp-addons-previous; fi",
    "if ! (mv -f /usr/local/bin/.clp-addons.new /usr/local/bin/clp-addons &&",
    "      systemctl restart clp-addons-auth.socket clp-addons-auth.service clp-addons.service &&",
    "      clp-addons repair); then",
    "  if [ -e /root/clp-addons-previous ]; then",
    "    ln -f /root/clp-addons-previous /usr/local/bin/.clp-addons.rollback",
    "    mv -f /usr/local/bin/.clp-addons.rollback /usr/local/bin/clp-addons",
    "  fi",
    "  systemctl restart clp-addons-auth.socket clp-addons-auth.service clp-addons.service",
    "  exit 1",
    "fi",
  ].join("\n")]);
} finally {
  rmSync(controlDir, { recursive: true, force: true });
}
