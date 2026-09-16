/**
 * What an addon asks to have injected into one of CloudPanel's own templates.
 *
 * This lived in `cli/paths.ts`, which meant the module holding the project's
 * path constants imported every addon's target list in order to describe them
 * -- a leaf that had become a catalog. The shape belongs neither to the paths
 * nor to any one addon, so it sits here and both sides import it.
 */
export interface AddonTarget {
  /** Stable identifier for this injection within the addon. */
  slug: string;
  /** Template file, relative to CloudPanel's template root. */
  template: string;
  /** Marker the injected block is placed after. */
  anchorAfter?: string;
  /** Marker the injected block is placed before. */
  anchorBefore?: string;
  /** The block itself, given the URL the addon is mounted at. */
  snippet: (addonUrl: string) => string;
  /** Whether an install must abort when this target cannot be patched. */
  required: boolean;
}
