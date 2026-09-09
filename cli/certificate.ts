import { openSync, readSync, closeSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fatal, log } from "./util";

/** An unattended install never implies consent to certificate issuance. */
export function requestCertificate(domain: string, choice: string | true | undefined): void {
  if (choice !== undefined && choice !== "yes" && choice !== "no") {
    fatal("--certificate must be yes or no");
  }
  if (choice === "no") return;
  let accepted = choice === "yes";
  if (choice === undefined) {
    let fd: number | undefined;
    try {
      fd = openSync("/dev/tty", "r+");
      writeSync(fd, `\nRequest a Let's Encrypt certificate for ${domain}? DNS must point here. [Y/n]: `);
      const byte = Buffer.alloc(1);
      let reply = "";
      while (readSync(fd, byte, 0, 1, null) > 0) {
        if (byte[0] === 10) { accepted = /^(y|yes)?$/i.test(reply.trim()); break; }
        reply += byte.toString();
        if (reply.length > 128) break;
      }
    } catch { /* no controlling terminal */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  if (accepted) {
    const result = spawnSync("clpctl", ["lets-encrypt:install:certificate", `--domainName=${domain}`], { stdio: "inherit" });
    if (result.status === 0) { log.ok(`certificate installed for ${domain}`); return; }
    log.warn("Certificate issuance failed. Check DNS and retry:");
  } else {
    log.warn("Certificate issuance skipped. HTTPS requires a valid certificate. To issue one:");
  }
  log.plain(`  clpctl lets-encrypt:install:certificate --domainName=${domain}`);
}
