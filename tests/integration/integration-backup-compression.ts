// Run as root on a CloudPanel test host with php8.1, tar and zstd installed.
// bun tests/integration/integration-backup-compression.ts
// Or compile this file with bun build --compile and run that binary there.
// Only temporary copies and fictional files are changed; no backup is uploaded.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  DEFAULT_BACKUP_COMPRESSION, DEFAULT_BACKUP_COMPRESSION_PATHS, backupCompressionStatus, reconcileBackupCompression,
} from "../../addons/system-tweaks/backup-compression";

if (process.getuid?.() !== 0) throw new Error("run on a CloudPanel test host as root");
const app = "/home/clp/htdocs/app/files";
const dir = mkdtempSync(join(tmpdir(), "clp-zstd-integration-"));
const php = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
function run(command: string[], success = true): void {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (success) assert.equal(result.exitCode, 0, `${command[0]}: ${result.stderr.toString()}`);
  else assert.notEqual(result.exitCode, 0, "a broken compressor must fail archive creation");
}

try {
  const remoteCommand = join(dir, "RemoteBackupCreateCommand.php");
  const tarCommand = join(dir, "TarCreateCommand.php");
  copyFileSync(DEFAULT_BACKUP_COMPRESSION_PATHS.remoteCommand, remoteCommand);
  copyFileSync(DEFAULT_BACKUP_COMPRESSION_PATHS.tarCommand, tarCommand);
  const original = readFileSync(remoteCommand, "utf8");
  const options = { paths: { remoteCommand, tarCommand } };
  const site = join(dir, "site");
  mkdirSync(join(site, "excluded"), { recursive: true });
  mkdirSync(join(site, "backups"));
  writeFileSync(join(site, "index.php"), "<?php echo 'backup restore test';\n".repeat(2000));
  writeFileSync(join(site, "excluded", "private.txt"), "excluded from backup");
  writeFileSync(join(site, "backups", "database.sql.gz"), Bun.gzipSync("CREATE TABLE demo (id int); INSERT INTO demo VALUES (42);"));
  symlinkSync("index.php", join(site, "index-link"));
  writeFileSync(join(dir, "site-vhost"), "server { server_name backup.example.com; }\n");
  const archive = join(dir, "backup.tar");
  const harness = join(dir, "create.php");
  const uploaded = join(dir, "upload-reached");
  const writeHarness = (block: string) => writeFileSync(harness, `<?php
require ${php(join(app, "vendor/autoload.php"))};
$sources = [escapeshellarg(${php(`${basename(dir)}/site`)}), escapeshellarg(${php(`${basename(dir)}/site-vhost`)})];
$destinationFile = ${php(archive)};
$excludes = ['excluded'];
$tarCreator = new \\App\\Backup\\TarCreator();
try {
${block}
file_put_contents(${php(uploaded)}, $destinationFile);
} catch (\\Throwable $error) {
  @unlink($destinationFile);
  fwrite(STDERR, $error->getMessage());
  exit(1);
}
`);
  const verifyRestore = (path: string) => {
    const restore = join(dir, "restore");
    rmSync(restore, { recursive: true, force: true });
    mkdirSync(restore);
    run(["/bin/tar", "-xf", path, "-C", restore]);
    const restored = join(restore, basename(dir));
    for (const name of ["index.php", "backups/database.sql.gz"]) {
      assert.deepEqual(readFileSync(join(restored, "site", name)), readFileSync(join(site, name)));
    }
    assert.equal(readlinkSync(join(restored, "site/index-link")), "index.php");
    assert.equal(existsSync(join(restored, "site/excluded")), false);
    assert.deepEqual(readFileSync(join(restored, "site-vhost")), readFileSync(join(dir, "site-vhost")));
  };
  for (const [level, threads] of [[3, 1], [6, 2]] as const) {
    const setting = { enabled: true, level, threads };
    assert.equal(reconcileBackupCompression(setting, options), true);
    assert.equal(backupCompressionStatus(setting, options).active, true);
    const patched = readFileSync(remoteCommand, "utf8");
    const block = patched.match(/\/\* clp-addons:backup-zstd:\d+:\d+ \*\/[\s\S]*?\/\* clp-addons:backup-zstd:end \*\//)?.[0];
    assert.ok(block);
    writeHarness(block);
    run(["/usr/bin/php8.1", "-n", "-l", remoteCommand]);
    run(["/usr/bin/php8.1", harness]);
    assert.equal(readFileSync(uploaded, "utf8"), archive + ".zst");
    run(["/usr/bin/zstd", "-t", archive + ".zst"]);
    verifyRestore(archive + ".zst");
    rmSync(uploaded);
    // Use the real CloudPanel command executor's failure handling with a
    // failing compressor. Its caller must not advance to the upload.
    writeHarness(block.replace(`/usr/bin/zstd -${level} -T${threads}`, "/bin/false"));
    run(["/usr/bin/php8.1", harness], false);
    assert.equal(existsSync(uploaded), false);
    assert.equal(existsSync(archive + ".zst"), false);
    console.log(`Zstandard level ${level}, ${threads} worker(s): archive, excludes, symlink, database dump, restore and compressor failure passed`);
  }
  assert.equal(reconcileBackupCompression(DEFAULT_BACKUP_COMPRESSION, options), true);
  assert.equal(readFileSync(remoteCommand, "utf8"), original);
  writeHarness("$tarCreator->create($sources, $destinationFile, $excludes);");
  run(["/usr/bin/php8.1", harness]);
  assert.equal(readFileSync(uploaded, "utf8"), archive);
  verifyRestore(archive);
  console.log("Switching off: exact original source and uncompressed backup restore passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
