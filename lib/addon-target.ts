/** What an addon asks to have injected into one of CloudPanel's own templates. */
export interface AddonTarget {
  /** Stable identifier for this injection within the addon. */
  slug: string;
  /** Template file, relative to CloudPanel's template root. */
  template: string;
  anchorAfter?: string;
  anchorBefore?: string;
  /** The block itself, given the URL the addon is mounted at. */
  snippet: (addonUrl: string) => string;
  /** Whether an install must abort when this target cannot be patched. */
  required: boolean;
}
