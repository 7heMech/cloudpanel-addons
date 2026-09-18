// Builds the binary and installs it on the staging CloudPanel box. The services
// hold the installed binary open, so upload to a scratch path, stop them, then
// install and let `clp-addons repair` start everything again.
//
//   bun tools/deploy-stg.ts
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.STG_HOST || "root@46.225.93.37";
const key = process.env.STG_KEY || join(homedir(), ".ssh/cloudpanel-addons-dev-0bad61aa9144");
// A workstation already knows this box; a CI runner does not, and learning the
// host key on connection would let anything answering that address receive a
// root command sequence. STG_KNOWN_HOSTS pins it instead.
const knownHosts = process.env.STG_KNOWN_HOSTS;
const sshOptions = [
  "-o", "BatchMode=yes",
  ...(knownHosts ? ["-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes"] : []),
  "-i", key,
];

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: repo, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

await run(["bun", "run", "build"]);
await run(["scp", ...sshOptions, join(repo, "dist/clp-addons-linux-x64"), `${host}:/root/clp-addons-new`]);
await run(["ssh", ...sshOptions, host, [
  "set -e",
  // Keep the running binary so a failed install or repair can be put back
  // instead of leaving staging with its services stopped.
  "cp -a /usr/local/bin/clp-addons /root/clp-addons-previous",
  "systemctl stop clp-addons.service clp-addons-auth.service clp-addons-auth.socket",
  "if ! (install -m 0755 -o root -g root /root/clp-addons-new /usr/local/bin/clp-addons && clp-addons repair); then",
  "  cp -a /root/clp-addons-previous /usr/local/bin/clp-addons",
  "  systemctl start clp-addons-auth.socket clp-addons-auth.service clp-addons.service",
  "  exit 1",
  "fi",
].join("\n")]);
