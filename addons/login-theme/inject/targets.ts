// Make CloudPanel's unauthenticated pages (login, two-factor) use the same
// dark-mode palette as the rest of the panel.
//
// CloudPanel already ships style-dark.css, whose selectors are gated by
// `html.dark`, and its Login layout already renders that class server-side
// when the `theme` cookie says dark. This addon only supplies what is missing
// before the panel's authenticated navigation can run: the device default.
// An explicitly saved `theme` cookie always wins; with no saved choice the
// device preference applies, and that default is persisted as the panel's
// native setting so the authenticated pages match after login.

import type { AddonTarget } from "../../../cli/paths";

const DEVICE_THEME_SCRIPT = `
          <script>
            (function () {
              function savedTheme() {
                var m = document.cookie.match(/(?:^|;\\s*)theme=([^;]*)/);
                return m ? m[1] : null;
              }
              function deviceDark() {
                return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
              }
              function applyTheme() {
                var saved = savedTheme();
                var dark = saved !== null ? saved === "dark" : deviceDark();
                document.documentElement.classList.toggle("dark", dark);
                document.documentElement.style.colorScheme = dark ? "dark" : "light";
                if (saved === null && dark) {
                  // Persist with the panel's own flags (long-lived, Secure on
                  // HTTPS) so its toggle can later clear exactly this cookie.
                  var cookie = "theme=dark; Path=/; Max-Age=15552000; SameSite=Lax";
                  try {
                    if (window.location && window.location.protocol === "https:") cookie += "; Secure";
                  } catch (e) {}
                  try { document.cookie = cookie; } catch (e) {}
                }
              }
              applyTheme();
              var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
              function onDeviceChange() {
                if (savedTheme() !== null) return;
                applyTheme();
              }
              if (media) {
                if (media.addEventListener) media.addEventListener("change", onDeviceChange);
                else if (media.addListener) media.addListener(onDeviceChange);
              }
            })();
          </script>`;

export const LOGIN_THEME_TARGETS: AddonTarget[] = [
  {
    slug: "login-device-theme",
    template: "Frontend/Login/layout.html.twig",
    // The shared layout every unauthenticated Login page extends (login, MFA).
    // Injecting into its <head> runs before the stylesheets load, so a dark
    // device never paints the white default first.
    anchorBefore: "{% block stylesheets %}",
    required: true,
    snippet: () => DEVICE_THEME_SCRIPT,
  },
];
