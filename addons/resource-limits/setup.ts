import type { SetupCheck, SetupStep } from "../../lib/addon-definition";
import { newSiteCategory } from "./action";

export function newSiteCategoryCheck(category: string | null): SetupCheck {
  return category
    ? { state: "done", reason: `New sites join ${category}` }
    : { state: "todo", reason: "New sites keep CloudPanel's PHP limits" };
}

export const RESOURCE_LIMITS_SETUP: SetupStep[] = [
  { id: "php-limits", level: "sites", title: "PHP limits for new sites", href: "/addons/resource-limits/#rl-categories", check: () => newSiteCategoryCheck(newSiteCategory()) },
];
