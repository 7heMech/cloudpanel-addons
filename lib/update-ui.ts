import { esc } from "./app-http";

export const UPDATE_PATH = "/addons/update";
export const CHANGELOG_URL = "https://github.com/7heMech/cloudpanel-addons/releases/latest";

// Shared by the native CloudPanel header and every addon page. The id keeps
// CloudPanel's 75px navigation line-height and dark-mode link rules out of these
// compact controls, without changing the panel's other links.
export const UPDATE_STYLE = `
#clp-addons-update-notice {
  --update-text: #23774b; --update-bg: #eaf7ef; --update-border: #c5e6d1;
  --update-link: #52606d; --update-link-border: #d3d3d3; --update-hover: #f3f5f7;
  display: inline-flex; align-items: center; align-self: center; gap: 8px;
  flex: 0 1 auto; min-width: 0; max-width: 100%; box-sizing: border-box;
  font-family: "Helvetica Neue", "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 12px; line-height: 1.25; vertical-align: middle;
}
html.dark #clp-addons-update-notice {
  --update-text: #a5dec0; --update-bg: #19392c; --update-border: #345944;
  --update-link: #c9d1d9; --update-link-border: #444c59; --update-hover: #303640;
}
#clp-addons-update-notice .clp-addon-update-badge {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 160px;
  height: 28px; padding: 0 9px; box-sizing: border-box; border-radius: 999px;
  background: var(--update-bg); color: var(--update-text); border: 1px solid var(--update-border);
  font-size: 12px; font-weight: 600; line-height: 1.25; white-space: nowrap;
}
#clp-addons-update-notice .dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: currentColor; }
#clp-addons-update-notice .update-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
#clp-addons-update-notice a {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  height: 30px; margin: 0; padding: 0 10px; box-sizing: border-box;
  border: 1px solid var(--update-link-border); border-radius: 4px;
  background: transparent; color: var(--update-link); font-size: 12px;
  font-weight: 600; line-height: 1.25; white-space: nowrap; text-decoration: none;
  transition: background-color 0.15s, border-color 0.15s;
}
#clp-addons-update-notice a:hover { background: var(--update-hover); text-decoration: none; }
#clp-addons-update-notice a.clp-addon-update-link { color: #fff; background: #267ddd; border-color: #267ddd; }
#clp-addons-update-notice a.clp-addon-update-link:hover { background: #2e87eb; border-color: #2e87eb; }
#clp-addons-update-notice a:focus-visible { outline: 2px solid #267ddd; outline-offset: 3px; }
`;

export function updateNoticeHtml(latest: string, updateUrl = UPDATE_PATH): string {
  const version = latest.replace(/^v/, "");
  return `<div id="clp-addons-update-notice" role="group" aria-label="CloudPanel Addons update">
  <span class="clp-addon-update-badge" title="clp-addons v${esc(version)} available">
    <span class="dot" aria-hidden="true"></span><span class="update-label">v${esc(version)} available</span>
  </span>
  <a class="clp-addon-changelog-link" href="${CHANGELOG_URL}" target="_blank" rel="noopener noreferrer" aria-label="Changelog (opens in a new tab)">Changelog</a>
  <a class="clp-addon-update-link" href="${esc(updateUrl)}">Update</a>
</div>`;
}
