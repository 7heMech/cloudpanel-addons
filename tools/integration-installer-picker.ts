// Integration test for install.sh's interactive addon picker -- the
// arrow-key checkbox UI (and its plain-terminal numbered-prompt fallback)
// that runs when `--addons` is not passed on the command line.
//
// This test DOES run in CI (.github/workflows/ci.yml and release.yml). It is
// the only coverage of the picker's key handling, and unlike the other
// `integration-*.ts` scripts in this directory it needs neither root nor
// Docker -- only `bash` and util-linux `script`, both present on a bare
// GitHub Actions runner. `bun test` only collects `*.test.ts` / `*.spec.*` /
// `*_test.*`, so the `integration-` prefix keeps this out of that automatic
// discovery on purpose; CI invokes it explicitly instead.
//
// It does not run install.sh, or the installer, at all. It reads install.sh's
// source text and slices out just the picker function (see
// extractPicker() below), wraps that slice in a small synthetic harness that
// stands in for the rest of the script, and drives the result under a real
// pseudo-terminal so the picker's raw single-key reads from /dev/tty behave
// as they would for a real user.
//
// Why a PTY, and why `script` rather than a PTY library: the picker branches
// on `[[ -t 1 ]]` / `${TERM:-dumb}` and reads raw, unbuffered keystrokes with
// `read -rsn1 ... < /dev/tty`, so it needs an actual controlling terminal --
// a plain pipe will not do. Bun has no built-in PTY allocation, and this
// project intentionally avoids native addons. `script -qec '<cmd>' /dev/null`
// (util-linux, present on every GitHub Actions Ubuntu runner) allocates one
// for free: it runs <cmd> attached to a real pty, `-q` silences its banner,
// `-e` makes it exit with the child's real exit code (verified below), and
// `/dev/null` is only the typescript *log* destination -- the live I/O still
// flows through the spawned process's own stdout/stdin, which is exactly
// what `Bun.spawn` needs to pipe.
//
// Usage:
//   bun tools/integration-installer-picker.ts

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INSTALL_SH = join(import.meta.dir, "..", "install.sh");
const TMP_SCRIPT = join(Bun.env.TMPDIR ?? "/tmp", "clp-addons-picker-harness.sh");

/**
 * Slice the interactive picker function out of install.sh's source text.
 *
 * This is a deliberately textual, not structural, extraction: it grabs
 * everything between the `# --- choose addons` marker and the `IFS=','
 * read` line that consumes the result, then trims the front of that slice
 * to start at `have_tty()`. The markers are load-bearing -- if they move in
 * install.sh, this silently extracts the wrong text. The assertion below
 * exists so that failure is loud (a thrown error) instead of a picker test
 * that quietly stops testing the picker. This guard was not present in the
 * original Python version; it is the one place this port goes beyond a
 * literal translation.
 */
function extractPicker(source: string): string {
  const afterMarker = source.split("# --- choose addons")[1];
  if (afterMarker === undefined) {
    throw new Error("install.sh: marker '# --- choose addons' not found; cannot extract the picker");
  }
  const beforeRead = afterMarker.split("IFS=',' read")[0];
  if (beforeRead === undefined) {
    throw new Error("install.sh: \"IFS=',' read\" not found after the picker marker; cannot extract the picker");
  }
  const start = beforeRead.indexOf("have_tty()");
  if (start === -1) {
    throw new Error("install.sh: 'have_tty()' not found in the extracted slice; cannot extract the picker");
  }
  const picker = beforeRead.slice(start);

  // Hard assertion: the slice must be non-empty and must actually contain
  // the picker's known internals, so a future edit to install.sh that moves
  // or guts the picker fails this test loudly rather than producing a
  // vacuous pass on an empty or unrelated fragment.
  if (picker.trim().length === 0) {
    throw new Error("install.sh: extracted picker slice is empty");
  }
  const mustContain = ["have_tty()", "cursor=", "selected[cursor]", "picked+=", "$'\\033[A'", "$'\\033[B'"];
  for (const fragment of mustContain) {
    if (!picker.includes(fragment)) {
      throw new Error(
        `install.sh: extracted picker slice is missing expected internals (${JSON.stringify(fragment)}); ` +
          "the '# --- choose addons' / \"IFS=',' read\" markers may have moved. Slice was:\n" +
          picker,
      );
    }
  }

  return picker;
}

function buildHarness(picker: string): string {
  return `set -euo pipefail
AVAILABLE_ADDONS=(instatic stager)
SELECTED=""
ASSUME_YES=0
say() { printf '%s\\n' "$*"; }
die() { echo "$*"; exit 1; }
${picker}
printf "RESULT=%s\\n" "$SELECTED"
`;
}

interface Case {
  name: string;
  keys: string;
  /** Expected `$SELECTED` value, or `null` if the case is expected to cancel (exit 1). */
  expected: string | null;
  term: "xterm" | "dumb";
}

const CASES: Case[] = [
  { name: "all by default", keys: "\n", expected: "instatic,stager", term: "xterm" },
  { name: "arrow and space", keys: "\x1b[B \n", expected: "instatic", term: "xterm" },
  { name: "clear and choose", keys: "n \n", expected: "instatic", term: "xterm" },
  { name: "select all hotkey", keys: "na\n", expected: "instatic,stager", term: "xterm" },
  { name: "empty cannot submit", keys: "n\na\n", expected: "instatic,stager", term: "xterm" },
  { name: "cancel", keys: "q", expected: null, term: "xterm" },
  { name: "plain terminal", keys: "2\n", expected: "stager", term: "dumb" },
];

interface CaseResult {
  name: string;
  ok: boolean;
  message: string;
  /** Whether the checkbox UI (not the numbered fallback) was observed rendering. */
  sawCheckboxUi: boolean;
  sawNumberedFallback: boolean;
}

async function runCase(c: Case): Promise<CaseResult> {
  const proc = Bun.spawn({
    cmd: ["script", "-qec", `bash ${TMP_SCRIPT}`, "/dev/null"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, TERM: c.term },
  });

  let output = "";
  let sent = false;
  let sawCheckboxUi = false;
  let sawNumberedFallback = false;
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + 5000;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (chunk.done) {
        if (!sent) {
          // Timed out (or stream closed) before the render marker appeared.
          break;
        }
        // Stream closed after keys were sent; drain no further.
        break;
      }
      output += decoder.decode(chunk.value, { stream: true });

      if (!sent && (output.includes("[x] stager") || output.includes("[all]:"))) {
        if (output.includes("[x] stager")) sawCheckboxUi = true;
        if (output.includes("[all]:")) sawNumberedFallback = true;
        proc.stdin.write(c.keys);
        await proc.stdin.flush();
        sent = true;
      }
    }

    if (!sent) {
      proc.kill(9);
      return {
        name: c.name,
        ok: false,
        message: `timed out waiting for the picker to render before sending keys. Output so far:\n${output}`,
        sawCheckboxUi,
        sawNumberedFallback,
      };
    }

    // Keep draining until exit or deadline, so late output (and the process
    // exit code) are captured.
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }

    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) =>
        setTimeout(() => resolve(-1), Math.max(0, deadline - Date.now()) + 200),
      ),
    ]);

    if (exitCode === -1) {
      return {
        name: c.name,
        ok: false,
        message: `timed out waiting for the process to exit. Output so far:\n${output}`,
        sawCheckboxUi,
        sawNumberedFallback,
      };
    }

    if (c.expected === null) {
      if (exitCode !== 1) {
        return {
          name: c.name,
          ok: false,
          message: `expected exit 1 (cancelled), got ${exitCode}. Output:\n${output}`,
          sawCheckboxUi,
          sawNumberedFallback,
        };
      }
      return { name: c.name, ok: true, message: "", sawCheckboxUi, sawNumberedFallback };
    }

    if (exitCode !== 0) {
      return {
        name: c.name,
        ok: false,
        message: `expected exit 0, got ${exitCode}. Output:\n${output}`,
        sawCheckboxUi,
        sawNumberedFallback,
      };
    }
    const wantLine = `RESULT=${c.expected}\r\n`;
    if (!output.includes(wantLine)) {
      return {
        name: c.name,
        ok: false,
        message: `expected output to contain ${JSON.stringify(wantLine)}. Output:\n${output}`,
        sawCheckboxUi,
        sawNumberedFallback,
      };
    }
    return { name: c.name, ok: true, message: "", sawCheckboxUi, sawNumberedFallback };
  } finally {
    try {
      proc.kill(9);
    } catch {
      // already dead
    }
    reader.releaseLock();
  }
}

async function main(): Promise<void> {
  const source = readFileSync(INSTALL_SH, "utf-8");
  const picker = extractPicker(source);
  const harness = buildHarness(picker);
  writeFileSync(TMP_SCRIPT, harness);

  let failed = 0;
  try {
    for (const c of CASES) {
      const result = await runCase(c);
      if (result.ok) {
        console.log(`ok ${c.name}`);
      } else {
        console.log(`FAIL ${c.name}: ${result.message}`);
        failed++;
      }

      // Guard against a TERM regression producing a silently vacuous pass:
      // every xterm case must have actually rendered the arrow-key checkbox
      // UI, not fallen through to the numbered fallback prompt. If `script`
      // or the environment stops propagating TERM=xterm to the child, all
      // six arrow-key cases would exercise the numbered fallback instead and
      // (for cases whose keys happen to still parse under that prompt) could
      // still report green -- exactly the vacuous-pass failure mode this
      // check exists to catch.
      if (c.term === "xterm" && !result.sawCheckboxUi) {
        console.log(
          `FAIL ${c.name}: expected the checkbox UI ('[x] stager') to render under TERM=xterm, ` +
            `but it did not (saw numbered fallback: ${result.sawNumberedFallback}). ` +
            "TERM may not be propagating to the child process.",
        );
        failed++;
      }
      if (c.term === "dumb" && !result.sawNumberedFallback) {
        console.log(`FAIL ${c.name}: expected the numbered fallback prompt ('[all]:') to render under TERM=dumb.`);
        failed++;
      }
    }
  } finally {
    rmSync(TMP_SCRIPT, { force: true });
  }

  if (failed > 0) {
    console.log(`\n${failed} of ${CASES.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`\nall ${CASES.length} cases passed`);
}

await main();
