/**
 * The menu Panel Tweaks can put a Sites row's actions behind, as the one
 * thing two addons have to agree on to share it.
 *
 * An addon that adds a link to the action cell needs nothing from here: the
 * menu collects whatever links it finds. What it needs here is the other case
 * -- an action worth a place in the menu but not a link in every row of a list
 * read every day. Marking such a link `clp-addons-menu-only` hides it, and the
 * menu's own rule for the links inside it is what shows it again, so it appears
 * exactly when there is a menu to appear in and never otherwise.
 *
 * The addon that owns the link emits `MENU_ONLY_STYLE`, not Panel Tweaks:
 * an operator who never installed Panel Tweaks must still not be shown it.
 */
export const ROW_MENU_CLASS = "clp-addons-row-menu";

export const MENU_ONLY_CLASS = "clp-addons-menu-only";

/** Hides a menu-only action; `.clp-addons-row-menu > a` outranks it and wins. */
export const MENU_ONLY_STYLE = `.${MENU_ONLY_CLASS} { display: none; }`;
