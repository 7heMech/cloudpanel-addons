// A CloudPanel file the addons patch that they are leaving alone because it
// changed in a way they cannot prove their blocks still fit (lib/baseline.ts).
// `clp-addons status` and the Addons page both say what is held and what to do,
// in these words.
import type { Refusal } from "./baseline";
import { REPO } from "./paths";

export interface PanelHold {
  /** A template path under CloudPanel's templates directory, or a config file's path. */
  file: string;
  /** What the operator sees go missing: addon titles, or "Addons tab". */
  addons: string[];
  reason: Refusal;
  /** The package the file belongs to, such as CloudPanel or nginx-common. */
  package: string;
  recorded: string | null;
  installed: string | null;
}

export const UPDATES_GUIDE_URL = `https://github.com/${REPO}/blob/main/docs/cloudpanel-updates.md`;

/** What happened, in one sentence. */
export function holdSummary(hold: PanelHold): string {
  const pkg = hold.installed ? `${hold.package} ${hold.installed}` : hold.package;
  switch (hold.reason) {
    case "busy": return `${hold.package} is being updated.`;
    case "edited": return `${hold.file} changed, but ${pkg} was not updated.`;
    case "unrecorded": return `${hold.file} changed, and this box has no record of the ${hold.package} version it was patched under.`;
    case "stray-marker": return `${pkg} changed ${hold.file}, and part of an addon block is left in it.`;
    case "anchor-missing": return `${pkg} changed ${hold.file}, and a line the addons attach to is gone.`;
    case "anchor-repeated": return `${pkg} changed ${hold.file}, and a line the addons attach to now appears more than once.`;
    case "conflict": return `${pkg} changed ${hold.file}, and it now holds something the addons' block would clash with.`;
  }
}

/** What to do about it, in one sentence. */
export function holdAdvice(hold: PanelHold): string {
  switch (hold.reason) {
    case "busy": return "The addons check it again when the update finishes.";
    case "edited":
    case "unrecorded": return "If the change is wanted, run clp-addons repair --rebaseline on the server; otherwise put the file back.";
    case "stray-marker": return "Remove the leftover clp-addons lines from it, then run clp-addons repair.";
    case "anchor-missing":
    case "anchor-repeated":
    case "conflict": return "It stays off until a CloudPanel Addons release supports this version; run clp-addons update once one is out.";
  }
}

/** The journal line for a file recorded afresh, by an upgrade or by `repair --rebaseline`. */
export function rebaselineNote(file: string, pkg: string, from: string | null, to: string): string {
  return from === to
    ? `${file}: the change was accepted with --rebaseline; recorded it again and patched it`
    : `${pkg} ${from ?? "(unrecorded)"} to ${to} replaced ${file}; the blocks still fit, so it was recorded again and patched`;
}
