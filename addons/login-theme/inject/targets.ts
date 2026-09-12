// Make CloudPanel's unauthenticated login page use the same dark-mode palette
// as the rest of the panel when the browser or operating system prefers dark.
//
// CloudPanel already ships style-dark.css, whose selectors are gated by
// `html.dark`. The login page is rendered before the panel's authenticated
// navigation can run its normal theme code, so this addon only supplies the
// missing class and keeps it synchronized with the device preference.

import type { AddonTarget } from "../../../cli/paths";

const DEVICE_THEME_SCRIPT = `
          <script>
            (function () {
              var media = window.matchMedia("(prefers-color-scheme: dark)");
              function syncDeviceTheme() {
                document.documentElement.classList.toggle("dark", media.matches);
                document.documentElement.style.colorScheme = media.matches ? "dark" : "light";
              }
              syncDeviceTheme();
              if (media.addEventListener) media.addEventListener("change", syncDeviceTheme);
              else if (media.addListener) media.addListener(syncDeviceTheme);
            })();
          </script>`;

export const LOGIN_THEME_TARGETS: AddonTarget[] = [
  {
    slug: "login-device-theme",
    template: "Frontend/Login/login.html.twig",
    // This is the login page's top-level wrapper. Placing the script before it
    // applies the class before the form is painted, avoiding a light flash when
    // the device is already using dark mode.
    anchorBefore: '<div class="login-container">',
    required: true,
    snippet: () => DEVICE_THEME_SCRIPT,
  },
];
