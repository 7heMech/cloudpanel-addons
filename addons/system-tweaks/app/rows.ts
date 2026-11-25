// The pieces a tweak's row on the page is made of; each tweak module renders its own row with them.
import { esc } from "../../../lib/app-http";
import { badgeHtml, settingRowHtml, type SettingRow } from "../../../lib/app-ui";
import { declaresLock } from "../../../lib/root-locks";
import type { SystemTweaksVerb } from "../tweak";

export type Row = SettingRow;
export const badge = badgeHtml;
export const settingRow = settingRowHtml;

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
