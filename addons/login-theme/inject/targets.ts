// Give CloudPanel's unauthenticated pages a first-visit theme that follows the
// device.
//
// The panel already ships style-dark.css and renders `html.dark` server-side,
// but it derives that purely from a `theme` cookie: the value `dark` means
// dark and no cookie at all means light. There is no stored "light", so the
// only thing missing is the first-visit default. This addon records that visit
// and, for a dark device, writes the same cookie as the panel's theme switch.
// Afterward the panel owns the setting on every page.

import type { AddonTarget } from "../../../cli/paths";

/** Marker that the one-time device default has already been applied. */
const SEEDED_KEY = "clp_addons_device_theme";

const DEVICE_THEME_SCRIPT = `
          <script>
            (function () {
              try {
                // Record the first visit even when the panel already has a dark
                // cookie. If the user later switches to light, the panel deletes
                // that cookie and this marker keeps the choice from being reset.
                if (localStorage.getItem("${SEEDED_KEY}")) return;
                localStorage.setItem("${SEEDED_KEY}", "1");
                if (/(?:^|;\\s*)theme=/.test(document.cookie)) return;
                if (!window.matchMedia("(prefers-color-scheme: dark)").matches) return;
                // Byte for byte the cookie the panel's own #theme-switch writes
                // with Cookies.set("theme", "dark", { expires: 180, secure: true }),
                // so its switch clears exactly this cookie later.
                document.cookie = "theme=dark; path=/; expires=" +
                  new Date(Date.now() + 180 * 864e5).toUTCString() +
                  (location.protocol === "https:" ? "; secure" : "");
                document.documentElement.classList.add("dark");
              } catch (e) {}
            })();
          </script>`;

export const LOGIN_THEME_TARGETS: AddonTarget[] = [
  {
    slug: "login-device-theme",
    template: "Frontend/Login/layout.html.twig",
    // The shared layout every unauthenticated page extends (login, two-factor).
    // Injecting into its <head> runs before the stylesheets load, so a dark
    // device never paints the white default first.
    anchorBefore: "{% block stylesheets %}",
    required: true,
    snippet: () => DEVICE_THEME_SCRIPT,
  },
];
