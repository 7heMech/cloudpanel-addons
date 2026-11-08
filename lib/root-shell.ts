// Terminal decides who sees the root shell control; see
// docs/decisions/terminal.md#root.
import OPEN_JS from "./assets/terminal-open.client.js" with { type: "text" };
import ROOT_SHELL_JS from "./assets/root-shell.client.js" with { type: "text" };

export { OPEN_JS };

/** The prompt mark a site's own Terminal tab has, so every way into a shell looks alike. */
const ROOT_SHELL_MARK = `<span class="clp-root-shell-mark" aria-hidden="true" style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700;">&gt;_</span>`;

/**
 * Opens the root window, or with no script goes to it in this tab. The account
 * menu's copy, a fallback on CloudPanel's own pages, goes without the mark.
 */
export function rootShellLink(base: string, attributes: string, label: string, mark = true): string {
  return `<a ${attributes} href="${base}/root" title="Root terminal" onclick="clpOpenTerminal('${base}', '', event.shiftKey); return false;">${mark ? ROOT_SHELL_MARK : ""}${label}</a>`;
}

export function rootShellScript(base: string): string {
  return `${OPEN_JS}${ROOT_SHELL_JS}`.split("ADDON_URL").join(base);
}
