// The header control that opens a root shell, on CloudPanel's own pages and on
// the manager's copy of its header alike. Terminal decides who sees it; see
// docs/decisions/terminal.md#root.
import OPEN_JS from "./assets/terminal-open.client.js" with { type: "text" };
import ROOT_SHELL_JS from "./assets/root-shell.client.js" with { type: "text" };

export { OPEN_JS };

export const ROOT_SHELL_ICON = `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="m6 9 3 3-3 3"></path><path d="M12 15h6"></path></svg>`;

/** Opens the root window, or with no script goes to it in this tab. */
export function rootShellLink(base: string, attributes: string, label: string): string {
  return `<a ${attributes} href="${base}/root" title="Root terminal" onclick="clpOpenTerminal('${base}', '', event.shiftKey); return false;">${ROOT_SHELL_ICON}${label}</a>`;
}

export function rootShellScript(base: string): string {
  return `${OPEN_JS}${ROOT_SHELL_JS}`.split("ADDON_URL").join(base);
}
