import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import type { DiskState, GuardState } from "../action";
import CLIENT_JS from "./views.client.js" with { type: "text" };
export { CLIENT_JS };

export function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
function diskRow(disk: DiskState): string {
  return `<tr><td>${disk.paths.map(esc).join("<br>")}</td><td>${bytes(disk.available)} free / ${bytes(disk.total)}</td><td>${disk.usedPercent.toFixed(1)}%</td><td>${disk.freeInodes.toLocaleString()} free</td><td><span class="badge ${disk.level === "ok" ? "ok" : "warn"}">${esc(disk.level)}</span></td></tr>`;
}
export function dashboardView(state: GuardState): string {
  const s = state.settings;
  return `<div class="page-header"><div><h1>Resource Guard</h1><p class="subtitle">Keep image processing within a shared disk budget and watch the server’s remaining capacity.</p></div><button class="btn" id="clean-now" type="button">Clean eligible files</button></div>
  <div id="guard-message" class="alert" role="status" hidden></div>
  ${state.warnings.map((warning) => `<div class="alert" role="alert">${esc(warning)}</div>`).join("")}
  <div class="card"><div class="card-header"><h2>Image scratch protection</h2><span class="badge ${state.protected ? "ok" : "warn"}">${state.protected ? "Protected" : s.protection ? "Needs repair" : "Off"}</span></div><div class="card-body">
    <p>ImageMagick’s existing disk limit applies to each process. This shared scratch disk also limits the files left behind when requests are interrupted. When it fills, image processing can fail without filling the server disk.</p>
    <form id="guard-settings"><div class="form-grid">
      <div class="form-field"><label for="guard-protection">Image scratch protection</label><select id="guard-protection"><option value="false"${!s.protection ? " selected" : ""}>Off</option><option value="true"${s.protection ? " selected" : ""}>On</option></select><div class="hint">Turning on reserves disk space and reloads site PHP services. Turning off waits for the scratch disk to be released by running jobs.</div></div>
      <div class="form-field"><label for="guard-size">Shared scratch budget (MiB)</label><input id="guard-size" type="number" min="256" max="16384" value="${state.allocatedMiB ?? s.scratchMiB}"${state.allocatedMiB !== null ? " readonly" : ""}><div class="hint">256–16,384 MiB. All sites share this limit. ${state.allocatedMiB !== null ? "The allocated disk size is fixed; see the operator guide to resize it." : "The server must retain at least 2 GiB and 10% free space after allocation."}</div></div>
      <div class="form-field"><label for="guard-age">Orphan retention (hours)</label><input id="guard-age" type="number" min="24" max="720" value="${s.retentionHours}"><div class="hint">Files must be untouched for at least this long and have no open descriptors or memory mappings.</div></div>
      <div class="form-field"><label for="guard-legacy">Existing /tmp image files</label><select id="guard-legacy"><option value="false"${!s.cleanLegacyTmp ? " selected" : ""}>Report only</option><option value="true"${s.cleanLegacyTmp ? " selected" : ""}>Clean eligible magick-* files</option></select><div class="hint">Only files directly in /tmp. Sessions, uploads, other temporary files, and private service directories are excluded.</div></div>
      <div class="form-field"><label for="guard-free">Minimum free disk (MiB)</label><input id="guard-free" type="number" min="256" max="1048576" value="${s.minFreeMiB}"></div>
      <div class="form-field"><label for="guard-percent">Minimum free disk (%)</label><input id="guard-percent" type="number" min="1" max="50" value="${s.minFreePercent}"></div>
      <div class="form-field"><label for="guard-inodes">Minimum free inodes (%)</label><input id="guard-inodes" type="number" min="1" max="50" value="${s.minInodePercent}"></div>
    </div><div class="toolbar"><button class="btn primary" type="submit">Save settings</button></div></form>
    <p class="hint">Disk checks run independently every five minutes. Warnings appear here and in the Resource Guard system journal. PHP worker categories remain in <a href="/addons/php-resources/">PHP Resources</a>.</p>
  </div></div>
  <div class="card"><div class="card-header"><h2>Filesystem capacity</h2></div><div class="table-wrap"><table><thead><tr><th>Locations sharing a disk</th><th>Capacity</th><th>Used</th><th>Inodes</th><th>Status</th></tr></thead><tbody>${state.disks.map(diskRow).join("")}${state.scratch ? diskRow({ ...state.scratch, paths: ["Image scratch disk"] }) : ""}</tbody></table></div></div>
  <div class="card"><div class="card-header"><h2>Image temporary files</h2></div><div class="card-body"><p>Bounded scratch: ${state.files ? `${state.files.files} files using ${bytes(state.files.bytes)}` : "not mounted"}. Existing /tmp: ${state.legacy ? `${state.legacy.files} files using ${bytes(state.legacy.bytes)}` : "unavailable"}.</p>
    ${state.files?.owners.length || state.legacy?.owners.length ? `<div class="table-wrap"><table><thead><tr><th>Location</th><th>Site user</th><th>Files</th><th>Allocated space</th></tr></thead><tbody>${[["Scratch", state.files], ["/tmp", state.legacy]].map(([label, inventory]) => (inventory as GuardState["files"])?.owners.map((owner) => `<tr><td>${esc(label)}</td><td>${esc(owner.user)}</td><td>${owner.files}</td><td>${bytes(owner.bytes)}</td></tr>`).join("") ?? "").join("")}</tbody></table></div>` : ""}
    <p class="hint">${state.lastCheck ? `Last check: ${esc(state.lastCheck.at)}. ${state.lastCheck.cleanup ? `Removed ${state.lastCheck.cleanup.removed} files (${bytes(state.lastCheck.cleanup.bytes)}); retained ${state.lastCheck.cleanup.active} files with active references.` : ""}` : "The first scheduled check has not run yet."}</p>
    ${state.verifiedPhp.length ? `<p class="hint">PHP Imagick verified when protection was applied: ${state.verifiedPhp.map((probe) => `${esc(probe.php)} (per-process disk limit ${bytes(probe.diskLimit)})`).join(", ")}.</p>` : ""}
  </div></div>`;
}
export function layout(content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout("Resource Guard", content, {
    brand: "Resource Guard", base: "/addons/resource-guard", nav: [], script: CLIENT_JS,
    css: ".table-wrap{overflow-x:auto}.card-body{padding:1.2rem}.card-body>p:first-child{margin-top:0}#guard-settings .toolbar{margin-top:1rem}.page-header{gap:1rem;flex-wrap:wrap}",
    updateNotice: notice,
  });
}
