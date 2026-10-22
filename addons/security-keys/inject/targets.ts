// What Security Keys adds to CloudPanel's own pages: a button under the login
// form, and a card under Two-Factor Authentication on Account > Security,
// where every panel user manages their own keys.
//
// Both are wrapped in `verbatim` so nothing in the scripts is read as Twig.
// Neither is `required`: a CloudPanel release that moves either costs that
// half, not the addon.

import type { AddonTarget } from "../../../lib/addon-target";
import LOGIN_SCRIPT from "./login.client.js" with { type: "text" };
import LOGIN_STYLE from "./login.css" with { type: "text" };
import ACCOUNT_SCRIPT from "./account.client.js" with { type: "text" };
import ACCOUNT_STYLE from "./account.css" with { type: "text" };
import WEBAUTHN_SCRIPT from "./webauthn.client.js" with { type: "text" };

function script(source: string, url: string): string {
  return `<script>(function () {\n${WEBAUTHN_SCRIPT}\n${source.split("ADDON_URL").join(url)}\n})();</script>`;
}

export const SECURITY_KEYS_TARGETS: AddonTarget[] = [
  {
    slug: "login-button",
    template: "Frontend/Login/login.html.twig",
    anchorAfter: "</form>",
    required: false,
    snippet: (url) => `{% verbatim %}
      <div id="clp-passkey" class="clp-passkey" hidden>
        <div class="clp-passkey-or"><span>or</span></div>
        <div id="clp-passkey-error" class="alert alert-danger" role="alert" hidden></div>
        <button type="button" class="btn btn-white btn-login">Sign in with a security key</button>
      </div>
      <style>${LOGIN_STYLE}</style>
      ${script(LOGIN_SCRIPT, url)}
      {% endverbatim %}`,
  },
  {
    slug: "account-card",
    template: "Frontend/User/Account/security.html.twig",
    anchorAfter: "          {% endif %}\n        </div>\n       </div>",
    required: false,
    snippet: (url) => `{% verbatim %}
      <div class="card clp-security-keys" id="clp-security-keys">
        <div class="card-header">Security Keys</div>
        <div class="card-body">
          <p>Sign in without your password using a passkey or a hardware key such as a YubiKey. The key asks for its PIN, your fingerprint or your device's unlock every time.</p>
          <div class="alert alert-danger clp-sk-error" role="alert" hidden></div>
          <div class="clp-sk-list"></div>
          <p class="clp-sk-unsupported" hidden>Security keys work only when the panel is open on its hostname with a valid certificate, not on an IP address.</p>
          <form class="clp-sk-add" hidden>
            <input type="text" class="form-control form-control-lg" maxlength="64" placeholder="Key name, e.g. YubiKey" aria-label="Key name">
            <button type="submit" class="btn btn-blue btn-lg">Add Security Key</button>
          </form>
        </div>
      </div>
      <style>${ACCOUNT_STYLE}</style>
      ${script(ACCOUNT_SCRIPT, url)}
      {% endverbatim %}`,
  },
];
