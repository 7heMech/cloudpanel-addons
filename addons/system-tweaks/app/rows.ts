// The pieces a tweak's row on the page is made of; each tweak module renders its own row with them.
import { esc } from "../../../lib/app-http";
import { declaresLock } from "../../../lib/root-locks";
import type { SystemTweaksVerb } from "../tweak";

export function badge(text: string, tone: "ok" | "warn" | "bad" | "plain"): string {
  const state = { ok: " tone-ok", warn: " tone-warn", bad: " tone-bad", plain: "" }[tone];
  return `<span class="badge${state}">${esc(text)}</span>`;
}

export interface Row {
  key: string;
  title: string;
  /** One paragraph, or a line each. */
  description: string | string[];
  /** The switch's state; a row with `control` instead has none. */
  checked?: boolean;
  disabled?: boolean;
  onchange?: string;
  /** What sits where the switch would, such as a select. */
  control?: string;
  extra?: string;
}

export function settingRow(row: Row): string {
  const note = `tweak-note-${row.key}`;
  const control = row.control ?? `
            <label class="switch" title="${esc(row.title)}">
              <input type="checkbox" data-setting="${esc(row.key)}" onchange="${row.onchange}"${row.checked ? " checked" : ""}
                ${row.disabled ? "disabled " : ""}aria-label="${esc(row.title)}">
              <span></span>
            </label>`;
  return `
      <div class="tweak-row">
        <div class="tweak-body">
          <div class="tweak-heading">
            <h3>${esc(row.title)}<button class="tweak-more" type="button" aria-expanded="false"
              aria-controls="${note}" aria-label="What ${esc(row.title.toLowerCase())} does"
              onclick="toggleNote(this)"></button></h3>${control}
          </div>
          <div class="tweak-note" id="${note}">${[row.description].flat().map((line) => `<p>${esc(line)}</p>`).join("")}</div>${row.extra ?? ""}
        </div>
      </div>`;
}

/** A row of a protection root can lock (`clp-addons lock system-tweaks`): while it is, an on switch stays on and an off one can only go on. */
export function lockableRow(verb: SystemTweaksVerb, row: Row, locked: boolean): string {
  return settingRow({ ...row, disabled: row.disabled || (frozen(verb, locked) && !!row.checked) });
}

/** A switch row: its verb's route is the verb without `set-`. */
export function switchRow(verb: SystemTweaksVerb, row: Omit<Row, "onchange">, locked: boolean): string {
  return lockableRow(verb, { ...row, onchange: `setSwitch(this, '${verb.replace(/^set-/, "")}')` }, locked);
}

/** Whether root's lock covers this verb, as `verbs.ts` declares and the gateway enforces. */
export function frozen(verb: SystemTweaksVerb, locked: boolean): boolean {
  return locked && declaresLock("system-tweaks", verb);
}

export function warning(text: string): string {
  return `<p class="notice st-inline-notice">${text}</p>`;
}

/** The status line under a row's description. */
export function statusLine(html: string): string {
  return `<p class="st-status">${html}</p>`;
}

export function listing(items: string[]): string {
  return esc(items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "");
}

/** A row of a table that pairs a name with its state. */
export function stateRow(name: string, detail: string, state: string): string {
  const shown = detail && detail.toLowerCase() !== name.toLowerCase();
  return `
          <tr><td><span class="st-name">${esc(name)}</span>${shown ? `<span class="hint st-detail">${esc(detail)}</span>` : ""}</td>
            <td class="st-state">${state}</td></tr>`;
}
