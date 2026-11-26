import { errorMessage } from "../lib/errors";
import { dashboardUrl } from "./addons";
import { ADDONS, addonEnabled, offeredAddonNames } from "../addons/catalog";
import { unitActive } from "../lib/systemd";
import { MANAGER_UNIT } from "../lib/paths";
import { CLI_VERSION } from "../lib/version";
import { cmdRepair } from "./repair";
import { cmdStatus } from "./status";
import { applyDisable, applyEnable } from "./toggle";
import { cmdUpdate } from "./update";
import { log, paint } from "../lib/log";
import { checkCliUpdate, type CliUpdateInfo } from "../lib/update-check";

const KEYS = "↑/↓ move · Space toggle · Enter apply · s status · r repair · u update · q quit";
const QUIT_KEYS = ["q", "\x1b", "\x03", "\x04"];

interface MenuState {
  /** The addons this box's architecture can run, and any already enabled. */
  names: string[];
  cursor: number;
  enabled: Set<string>;
  wanted: Set<string>;
  manager: string;
  /** Worked out once: a redraw runs on every keypress. */
  dashboard: string;
  update: CliUpdateInfo | null;
}

function readEnabled(names: string[]): Set<string> {
  return new Set(names.filter((name) => addonEnabled(ADDONS[name]!)));
}

function addonRows(names: string[], cursor: number, wanted: Set<string>, changed: (name: string) => boolean): string[] {
  const nameWidth = Math.max(...names.map((name) => name.length));
  return names.map((name, index) => {
    const on = wanted.has(name);
    const mark = on ? "[x]" : "[ ]";
    const pointer = index === cursor ? paint("36", "›") : " ";
    const label = `${mark} ${name.padEnd(nameWidth)}`;
    const note = changed(name) ? paint("33", on ? "enable" : "disable") : paint("2", ADDONS[name]!.description);
    return ` ${pointer} ${changed(name) ? paint("33", label) : index === cursor ? paint("1", label) : label}  ${note}`;
  });
}

function moved(key: string, cursor: number, count: number): number | null {
  if (key === "\x1b[A" || key === "k") return (cursor + count - 1) % count;
  if (key === "\x1b[B" || key === "j") return (cursor + 1) % count;
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
  const pending = state.names.filter(changed).length;
  return [
    ` ${header}`,
    ` ${paint("2", state.dashboard)}`,
    "",
    ...addonRows(state.names, state.cursor, state.wanted, changed),
    "",
    ` ${paint("2", KEYS)}${pending ? paint("33", `  ·  ${pending} pending`) : ""}`,
  ];
}

interface Terminal {
  input: Pick<NodeJS.ReadStream, "setRawMode" | "resume" | "pause" | "on" | "off">;
  output: { write(text: string): unknown; columns?: number };
}

const TTY: Terminal = { input: process.stdin, output: process.stdout };

function screen({ input, output }: Terminal) {
  let drawn = 0;
  return {
    get drawn() { return drawn; },
    draw(lines: string[]) {
      const width = Math.max(20, (output.columns ?? 80) - 1);
      output.write(`${drawn ? `\x1b[${drawn}A\r` : ""}\x1b[J${lines.map((line) => Bun.sliceAnsi(line, 0, width)).join("\n")}\n`);
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

export async function cmdMenu(): Promise<void> {
  const names = offeredAddonNames();
  const enabled = readEnabled(names);
  const state: MenuState = {
    names, cursor: 0, enabled, wanted: new Set(enabled), manager: unitActive(MANAGER_UNIT), dashboard: dashboardUrl(), update: null,
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
      log.err(errorMessage(error));
    }
    out.write("\n");
    state.names = offeredAddonNames();
    state.cursor = Math.min(state.cursor, Math.max(0, state.names.length - 1));
    state.enabled = readEnabled(state.names);
    state.wanted = new Set(state.enabled);
    state.manager = unitActive(MANAGER_UNIT);
    busy = false;
    capture();
    draw();
  };

  const apply = () => run(async () => {
    for (const name of state.names) {
      if (state.wanted.has(name) && !state.enabled.has(name)) await applyEnable(name);
    }
    for (const name of state.names) {
      if (!state.wanted.has(name) && state.enabled.has(name)) await applyDisable(name);
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
      const name = state.names[state.cursor]!;
      switch (key) {
        case "\x1b[A": case "k": case "\x1b[B": case "j":
          state.cursor = moved(key, state.cursor, state.names.length)!; break;
        case " ":
          toggle(state.wanted, name); break;
        case "\r": case "\n":
          if (state.names.every((item) => state.wanted.has(item) === state.enabled.has(item))) return;
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
