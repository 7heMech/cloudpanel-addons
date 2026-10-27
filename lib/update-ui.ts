import { esc } from "./app-http";
import { VERSION_TAG_RE } from "./semver";

export const UPDATE_PATH = "/addons/update";
export const RELEASES_URL = "https://github.com/7heMech/cloudpanel-addons/releases";

/** One release's notes, pre-releases included; every release when there is none to name, as on a development build. */
export function changelogUrl(version = ""): string {
  const tag = `v${version.replace(/^v/, "")}`;
  return VERSION_TAG_RE.test(tag) && tag !== "v0.0.0-dev" ? `${RELEASES_URL}/tag/${tag}` : RELEASES_URL;
}

// Shared by the native CloudPanel header and every addon page. The id keeps
// CloudPanel's 75px navigation line-height and dark-mode link rules out of these
// compact controls, without changing the panel's other links.
import UPDATE_STYLE from "./assets/update.css" with { type: "text" };
export { UPDATE_STYLE };

export function updateNoticeHtml(latest: string, updateUrl = UPDATE_PATH): string {
  const version = latest.replace(/^v/, "");
  return `<div id="clp-addons-update-notice" role="group" aria-label="CloudPanel Addons update">
  <span class="clp-addon-update-badge" title="clp-addons v${esc(version)} available">
    <span class="dot" aria-hidden="true"></span><span class="update-label">Addons · v${esc(version)} available</span>
  </span>
  <a class="clp-addon-changelog-link" href="${esc(changelogUrl(version))}" target="_blank" rel="noopener noreferrer" aria-label="Changelog (opens in a new tab)">Changelog</a>
  <a class="clp-addon-update-link" href="${esc(updateUrl)}">Update</a>
</div>`;
}
