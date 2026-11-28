// Builds the binary and installs it on the staging CloudPanel box.
//
// Most of the compiled binary is the same Bun runtime every time, so
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
import { CLI_ARTIFACT, cliArtifactForArch } from "../lib/paths";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.STG_HOST || "root@2a03:4000:2:95a:147b:36ff:fea4:2563";
// ssh takes a bare IPv6 address, but scp and rsync need it bracketed before `:path`.
const copyHost = host.replace(/^([^@]+@)?([0-9a-fA-F]*:[0-9a-fA-F:.]+)$/, (_, user = "", address) => `${user}[${address}]`);
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

async function output(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: repo, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
  return text.trim();
}

const MACHINE_ARCH: Record<string, string> = { x86_64: "x64", aarch64: "arm64" };

const shellQuote = (parts: string[]) => parts.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");

try {
  // The connection is opened while the build runs, so the upload starts on an
  // authenticated channel instead of paying a handshake of its own.
  const machine = output(["ssh", ...sshOptions, host, "uname -m"]);
  await run(["bun", "run", "build"]);
  // The build is for this machine's architecture, so it must be the box's too.
  const remote = await machine;
  const wanted = cliArtifactForArch(MACHINE_ARCH[remote] ?? remote);
  if (wanted !== CLI_ARTIFACT) throw new Error(`${host} needs ${wanted}, but this machine builds ${CLI_ARTIFACT}`);
  const binary = join(repo, "dist", CLI_ARTIFACT);
  // rsync verifies the reconstructed file, so a partial upload cannot be
  // installed as if it were whole. Somewhere without it still deploys, whole.
  await run(Bun.which("rsync")
    ? ["rsync", "--inplace", "-e", shellQuote(["ssh", ...sshOptions]), binary, `${copyHost}:/root/clp-addons-new`]
    : ["scp", ...sshOptions, binary, `${copyHost}:/root/clp-addons-new`]);
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
