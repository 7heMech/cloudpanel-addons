// `clp-addons` with no arguments, in a root terminal: the addons, their
// state, and the few things an operator does to them, one key each. Toggles go
// through the same enable and disable the Addons page runs.

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

function frame(state: MenuState): string[] {
  const manager = state.manager;
  const header = [
    paint("1", `CloudPanel Addons v${CLI_VERSION.replace(/^v/, "")}`),
    manager === "active" ? paint("32", "● manager active") : paint("31", `● manager ${manager}`),
    state.update?.hasUpdate ? paint("33", `v${state.update.latest} available`) : "",
  ].filter(Boolean).join("  ");
  const nameWidth = Math.max(...ADDON_NAMES.map((name) => name.length));
  const rows = ADDON_NAMES.map((name, index) => {
    const on = state.wanted.has(name);
    const changed = on !== state.enabled.has(name);
    const mark = on ? "[x]" : "[ ]";
    const pointer = index === state.cursor ? paint("36", "›") : " ";
    const label = `${mark} ${name.padEnd(nameWidth)}`;
    const note = changed ? paint("33", on ? "enable" : "disable") : paint("2", ADDONS[name]!.description);
    return ` ${pointer} ${changed ? paint("33", label) : index === state.cursor ? paint("1", label) : label}  ${note}`;
  });
  const pending = ADDON_NAMES.filter((name) => state.wanted.has(name) !== state.enabled.has(name)).length;
  return [
    ` ${header}`,
    ` ${paint("2", dashboardUrl())}`,
    "",
    ...rows,
    "",
    ` ${paint("2", KEYS)}${pending ? paint("33", `  ·  ${pending} pending`) : ""}`,
  ];
}

export async function cmdMenu(): Promise<void> {
  const enabled = readEnabled();
  const state: MenuState = {
    cursor: 0, enabled, wanted: new Set(enabled), manager: unitActive(MANAGER_UNIT), update: null,
  };
  const input = process.stdin;
  const out = process.stdout;
  let drawn = 0;
  let busy = false;

  const draw = () => {
    const width = Math.max(20, (out.columns ?? 80) - 1);
    const lines = frame(state).map((line) => fit(line, width));
    out.write(`${drawn ? `\x1b[${drawn}A\r` : ""}\x1b[J${lines.join("\n")}\n`);
    drawn = lines.length;
  };

  const release = () => {
    input.setRawMode(false);
    input.pause();
    out.write("\x1b[?25h");
  };
  const capture = () => {
    out.write("\x1b[?25l");
    input.setRawMode(true);
    input.resume();
  };

  // Each runs below the menu with the terminal back in cooked mode, so its
  // output and Ctrl-C behave as they would for the command typed out.
  const run = async (task: () => unknown | Promise<unknown>): Promise<void> => {
    busy = true;
    release();
    drawn = 0;
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
        case "\x1b[A": case "k":
          state.cursor = (state.cursor + ADDON_NAMES.length - 1) % ADDON_NAMES.length; break;
        case "\x1b[B": case "j":
          state.cursor = (state.cursor + 1) % ADDON_NAMES.length; break;
        case " ":
          if (state.wanted.has(name)) state.wanted.delete(name);
          else state.wanted.add(name);
          break;
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
        case "q": case "\x1b": case "\x03": case "\x04":
          quit(); return;
        default:
          return;
      }
      draw();
    };

    capture();
    input.on("data", onKey);
    draw();
    checkCliUpdate(CLI_VERSION).then((update) => {
      state.update = update;
      if (!busy && drawn) draw();
    }, () => {});
  });
}
