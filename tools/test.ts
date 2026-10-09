// Runs each test file in a `bun test` process of its own.
//
// Several suites replace modules with mock.module -- node:fs among them -- and
// Bun keeps a replacement for the rest of the process. `bun test --isolate`
// contained that, but on CI it intermittently left every process a test
// spawned hanging until the five-second timeout, for minutes at a time. A
// process per file contains the mocks without it, in the same time.
import { Glob } from "bun";

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : [...new Glob("tests/*.test.ts").scanSync()].sort();

const failed: string[] = [];
for (const file of files) {
  const proc = Bun.spawn([process.execPath, "test", "--max-concurrency=1", file], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await proc.exited !== 0) failed.push(file);
}

console.log(`\n${files.length - failed.length} of ${files.length} test files passed`);
for (const file of failed) console.log(`failed: ${file}`);
process.exit(failed.length === 0 ? 0 : 1);
