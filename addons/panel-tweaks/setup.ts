import type { SetupCheck, SetupStep } from "../../lib/addon-definition";
import { DEFAULT_PANEL_TWEAKS_PATHS, readTweaks } from "./action";

export function autoSslCheck(autoSsl: boolean): SetupCheck {
  return autoSsl
    ? { state: "done", reason: "New sites get a Let's Encrypt certificate" }
    : { state: "todo", reason: "New sites start on a self-signed certificate" };
}

export const PANEL_TWEAKS_SETUP: SetupStep[] = [
  { id: "auto-ssl", level: "provision", title: "Certificate at site creation", href: "/addons/panel-tweaks/#pt-sites", check: () => autoSslCheck(readTweaks(DEFAULT_PANEL_TWEAKS_PATHS).autoSsl) },
];
