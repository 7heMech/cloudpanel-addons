// `clp-addons` with no arguments, in a root terminal: the addons, their
// state, and the few things an operator does to them, one key each. Toggles go
// through the same enable and disable the Addons page runs. The installer's
// picker is the same list.

import { dashboardUrl } from "./addons";
import { ADDONS, ADDON_NAMES } from "./addon-catalog";
import { installedConfig, unitActive } from "./provision";
import { MANAGER_UNIT } from "./paths";
import { CLI_VERSION } from "./release";
import { cmdRepair } from "./repair";
import { cmdStatus } from "./status";
import { applyDisable, applyEnable } from "./toggle";
import { cmdUpdate } from "./update";
import { log } from "./util";
import { checkCliUpdate, type CliUpdateInfo } from "../lib/update-check";

const KEYS = "↑/↓ move · Space toggle · Enter apply · s status · r repair · u update · q quit";
const PICK_KEYS = "↑/↓ move · Space toggle · a all · n none · Enter install · q cancel";
const QUIT_KEYS = ["q", "\x1b", "\x03", "\x04"];

const paint = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;

interface MenuState {
  cursor: number;
  enabled: Set<string>;
  wanted: Set<string>;
  manager: string;
  update: CliUpdateInfo | null;
}

function readEnabled(): Set<string> {
  return new Set(ADDON_NAMES.filter((name) => installedConfig(ADDONS[name]!)));
}

function fit(line: string, width: number): string {
  // Measured without escapes so a colored line is cut at what shows.
  let visible = 0;
  let out = "";
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { out += part; continue; }
    const room = width - visible;
    if (room <= 0) continue;
    const chars = [...part];
    out += chars.slice(0, room).join("");
    visible += Math.min(chars.length, room);
  }
  return out;
}

/** A checkbox per addon, with its description or, once changed, what will happen to it. */
function addonRows(cursor: number, wanted: Set<string>, changed: (name: string) => boolean = () => false): string[] {
  const nameWidth = Math.max(...ADDON_NAMES.map((name) => name.length));
  return ADDON_NAMES.map((name, index) => {
    const on = wanted.has(name);
    const mark = on ? "[x]" : "[ ]";
    const pointer = index === cursor ? paint("36", "›") : " ";
    const label = `${mark} ${name.padEnd(nameWidth)}`;
    const note = changed(name) ? paint("33", on ? "enable" : "disable") : paint("2", ADDONS[name]!.description);
    return ` ${pointer} ${changed(name) ? paint("33", label) : index === cursor ? paint("1", label) : label}  ${note}`;
  });
}

/** The cursor after an up or down key, or null for any other key. */
function moved(key: string, cursor: number): number | null {
  if (key === "\x1b[A" || key === "k") return (cursor + ADDON_NAMES.length - 1) % ADDON_NAMES.length;
  if (key === "\x1b[B" || key === "j") return (cursor + 1) % ADDON_NAMES.length;
  return null;
}

function toggle(wanted: Set<string>, name: string): void {
  if (wanted.has(name)) wanted.delete(name);
  else wanted.add(name);
}

function frame(state: MenuState): string[] {
  const manager = state.manager;
  const header = [
    paint("1", `CloudPanel Addons v${CLI_VERSION.replace(/^v/, "")}`),
    manager === "active" ? paint("32", "● manager active") : paint("31", `● manager ${manager}`),
    state.update?.hasUpdate ? paint("33", `v${state.update.latest} available`) : "",
  ].filter(Boolean).join("  ");
  const changed = (name: string) => state.wanted.has(name) !== state.enabled.has(name);
  const pending = ADDON_NAMES.filter(changed).length;
  return [
    ` ${header}`,
    ` ${paint("2", dashboardUrl())}`,
    "",
    ...addonRows(state.cursor, state.wanted, changed),
    "",
    ` ${paint("2", KEYS)}${pending ? paint("33", `  ·  ${pending} pending`) : ""}`,
  ];
}

export interface Terminal {
  input: Pick<NodeJS.ReadStream, "setRawMode" | "resume" | "pause" | "on" | "off">;
  output: { write(text: string): unknown; columns?: number };
}

const TTY: Terminal = { input: process.stdin, output: process.stdout };

/** A block of lines redrawn in place, with keys read raw while captured. */
function screen({ input, output }: Terminal) {
  let drawn = 0;
  return {
    get drawn() { return drawn; },
    draw(lines: string[]) {
      const width = Math.max(20, (output.columns ?? 80) - 1);
      output.write(`${drawn ? `\x1b[${drawn}A\r` : ""}\x1b[J${lines.map((line) => fit(line, width)).join("\n")}\n`);
      drawn = lines.length;
    },
    /** Leaves the block where it is, so the next draw starts a new one below. */
    leave() { drawn = 0; },
    capture() {
      output.write("\x1b[?25l");
      input.setRawMode(true);
      input.resume();
    },
    release() {
      input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h");
    },
  };
}

/** The installer's question, starting from the preselected addons. Null when cancelled. */
export function pickAddons(terminal: Terminal = TTY): Promise<string[] | null> {
  const wanted = new Set(ADDON_NAMES.filter((name) => ADDONS[name]!.preselected));
  const view = screen(terminal);
  let cursor = 0;
  const draw = () => view.draw([
    ` ${paint("1", "Which addons should be installed?")}`,
    "",
    ...addonRows(cursor, wanted),
    "",
    ` ${paint("2", PICK_KEYS)}`,
  ]);

  return new Promise((resolve) => {
    const finish = (picked: string[] | null) => {
      terminal.input.off("data", onKey);
      view.release();
      resolve(picked);
    };
    const onKey = (chunk: Buffer) => {
      const key = chunk.toString("utf-8");
      const next = moved(key, cursor);
      if (next !== null) cursor = next;
      else if (key === " ") toggle(wanted, ADDON_NAMES[cursor]!);
      else if (key === "a") for (const name of ADDON_NAMES) wanted.add(name);
      else if (key === "n") wanted.clear();
      else if (key === "\r" || key === "\n") {
        if (wanted.size > 0) finish(ADDON_NAMES.filter((name) => wanted.has(name)));
        return;
      } else if (QUIT_KEYS.includes(key)) return finish(null);
      else return;
      draw();
    };
    view.capture();
    terminal.input.on("data", onKey);
    draw();
  });
}

export async function cmdMenu(): Promise<void> {
  const enabled = readEnabled();
  const state: MenuState = {
    cursor: 0, enabled, wanted: new Set(enabled), manager: unitActive(MANAGER_UNIT), update: null,
  };
  const input = process.stdin;
  const out = process.stdout;
  const view = screen(TTY);
  let busy = false;

  const draw = () => view.draw(frame(state));
  const { release, capture } = view;

  // Each runs below the menu with the terminal back in cooked mode, so its
  // output and Ctrl-C behave as they would for the command typed out.
  const run = async (task: () => unknown | Promise<unknown>): Promise<void> => {
    busy = true;
    release();
    view.leave();
    out.write("\n");
    try {
      await task();
    } catch (error) {
      log.err(error instanceof Error ? error.message : String(error));
    }
    out.write("\n");
    state.enabled = readEnabled();
    state.wanted = new Set(state.enabled);
    state.manager = unitActive(MANAGER_UNIT);
    busy = false;
    capture();
    draw();
  };

  const apply = () => run(async () => {
    for (const name of ADDON_NAMES) {
      if (state.wanted.has(name) && !state.enabled.has(name)) await applyEnable(name);
    }
    for (const name of ADDON_NAMES) {
      if (!state.wanted.has(name) && state.enabled.has(name)) applyDisable(name);
    }
  });

  return new Promise<void>((resolve, reject) => {
    const quit = () => {
      busy = true;
      input.off("data", onKey);
      release();
      resolve();
    };

    const onKey = (chunk: Buffer) => {
      if (busy) return;
      const key = chunk.toString("utf-8");
      const name = ADDON_NAMES[state.cursor]!;
      switch (key) {
        case "\x1b[A": case "k": case "\x1b[B": case "j":
          state.cursor = moved(key, state.cursor)!; break;
        case " ":
          toggle(state.wanted, name); break;
        case "\r": case "\n":
          if (ADDON_NAMES.every((item) => state.wanted.has(item) === state.enabled.has(item))) return;
          apply().catch(reject); return;
        case "s":
          run(cmdStatus).catch(reject); return;
        case "r":
          run(() => cmdRepair([])).catch(reject); return;
        case "u":
          // The process that would draw the menu again is the binary update
          // just replaced, so it ends here.
          input.off("data", onKey);
          busy = true;
          release();
          out.write("\n");
          cmdUpdate([]).then(resolve, reject);
          return;
        default:
          if (QUIT_KEYS.includes(key)) quit();
          return;
      }
      draw();
    };

    capture();
    input.on("data", onKey);
    draw();
    checkCliUpdate(CLI_VERSION).then((update) => {
      state.update = update;
      if (!busy && view.drawn) draw();
    }, () => {});
  });
}
