import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ADDONS, ADDON_NAMES } from "../cli/addon-catalog";
import { pickAddons, type Terminal } from "../cli/menu";

const PRESELECTED = ["maintenance", "panel-tweaks", "system-tweaks", "terminal", "security-keys"];

function pick(...keys: string[]): { result: Promise<string[] | null>; rawModes: boolean[]; screen: () => string } {
  const rawModes: boolean[] = [];
  const input = Object.assign(new EventEmitter(), {
    setRawMode: (mode: boolean) => { rawModes.push(mode); return input; },
    resume: () => input,
    pause: () => input,
  });
  let screen = "";
  const terminal = { input, output: { write: (text: string) => { screen += text; }, columns: 200 } } as unknown as Terminal;
  const result = pickAddons(terminal);
  for (const key of keys) input.emit("data", Buffer.from(key));
  return { result, rawModes, screen: () => screen };
}

test("the addons each definition preselects are the documented defaults", () => {
  expect(ADDON_NAMES.filter((name) => ADDONS[name]!.preselected)).toEqual(
    ADDON_NAMES.filter((name) => PRESELECTED.includes(name)),
  );
});

test("Enter installs the preselected addons, in catalog order", async () => {
  expect(await pick("\r").result).toEqual(ADDON_NAMES.filter((name) => PRESELECTED.includes(name)));
});

test("arrows move and Space toggles, wrapping at either end", async () => {
  // Down from the first addon reaches the second; up from the first, the last.
  const added = await pick("\x1b[B", " ", "\r").result;
  expect(added).toContain(ADDON_NAMES[1]!);
  const last = ADDON_NAMES.at(-1)!;
  const flipped = await pick("\x1b[A", " ", "\r").result;
  expect(flipped!.includes(last)).toBe(!PRESELECTED.includes(last));
});

test("n clears and a selects every addon", async () => {
  expect(await pick("n", " ", "\r").result).toEqual([ADDON_NAMES[0]!]);
  expect(await pick("n", "a", "\r").result).toEqual(ADDON_NAMES);
});

test("Enter does nothing while no addon is ticked", async () => {
  let settled = false;
  const picker = pick("n", "\r");
  picker.result.then(() => { settled = true; });
  await Bun.sleep(0);
  expect(settled).toBe(false);
});

test.each(["q", "\x1b", "\x03"])("%j cancels and gives the terminal back", async (key) => {
  const picker = pick(key);
  expect(await picker.result).toBeNull();
  expect(picker.rawModes).toEqual([true, false]);
});

test("each addon is listed with its description", async () => {
  const picker = pick("\r");
  await picker.result;
  for (const name of ADDON_NAMES) expect(picker.screen()).toContain(ADDONS[name]!.description.slice(0, 40));
});
