import { esc } from "../../../lib/app-http";
import { mountPath } from "../../../lib/mount";
import type { Branding, LogoSlot } from "../branding";

const BASE = mountPath("panel-tweaks");

interface Tile {
  slot: LogoSlot;
  title: string;
  mode?: "Light" | "Dark";
  /** What CloudPanel shows while the slot is empty. */
  fallback: string;
  accept: string;
  size?: string;
}

const IMAGES = "image/svg+xml,image/png,image/jpeg";

const HEADER_TILES: Tile[] = [
  { slot: "headerLight", title: "Header logo", mode: "Light", fallback: "/assets/images/logo.svg", accept: IMAGES },
  { slot: "headerDark", title: "Header logo", mode: "Dark", fallback: "/assets/images/logo-dark.svg", accept: IMAGES },
];

const SQUARE_TILES: Tile[] = [
  { slot: "markLight", title: "Mobile / login", mode: "Light", fallback: "/assets/images/cloudpanel-cloud.svg", accept: IMAGES },
  { slot: "markDark", title: "Mobile / login", mode: "Dark", fallback: "/assets/images/cloudpanel-cloud.svg", accept: IMAGES },
  { slot: "favicon", title: "Favicon", fallback: "/assets/images/favicon.svg", accept: "image/svg+xml,image/png,image/x-icon", size: "32×32" },
];

function tile(t: Tile, branding: Branding): string {
  const name = branding.logos[t.slot];
  const src = name ? `${BASE}/branding/${name}` : t.fallback;
  return `
        <div class="branding-tile${t.mode === "Dark" ? " is-dark" : ""}${t.slot === "favicon" ? " is-favicon" : ""}"
          data-slot="${t.slot}" data-fallback="${esc(t.fallback)}">
          <div class="branding-tile-head">
            ${t.mode ? `<span class="branding-mode">${t.mode}</span>` : ""}<span class="branding-tile-title">${esc(t.title)}</span>
            ${t.size ? `<span class="branding-tile-size">${t.size}</span>` : ""}
          </div>
          <div class="branding-tile-preview"><img src="${esc(src)}" alt="${esc(`${t.title}${t.mode ? ` (${t.mode.toLowerCase()})` : ""}`)}"></div>
          <div class="branding-tile-actions">
            <label class="btn">Choose file<input type="file" accept="${t.accept}" onchange="uploadLogo(this)" hidden></label>
            <button class="btn btn-danger branding-reset" type="button" onclick="resetLogo(this)"${name ? "" : " hidden"}>Reset</button>
          </div>
        </div>`;
}

function brandingSwitch(key: "customLogo" | "customCss" | "showFooter", title: string, branding: Branding): string {
  return `
          <div class="tweak-heading">
            <h3>${esc(title)}<button class="tweak-more" type="button" aria-expanded="false"
              aria-controls="branding-note-${key}" aria-label="What ${esc(title.toLowerCase())} does"
              onclick="toggleNote(this)"></button></h3>
            <label class="switch" title="${esc(title)}">
              <input type="checkbox" data-branding="${key}" onchange="setBrandingSwitch(this)"${branding[key] ? " checked" : ""}
                aria-label="${esc(title)}">
              <span></span>
            </label>
          </div>`;
}

function editor(id: string, name: "css" | "footerHtml", label: string, value: string, rows: number, placeholder: string): string {
  return `
          <label class="branding-label" for="${id}">${esc(label)}</label>
          <textarea id="${id}" name="${name}" class="branding-code" rows="${rows}" spellcheck="false"
            placeholder="${esc(placeholder)}" oninput="this.closest('.tweak-body').querySelector('.branding-save').disabled = false">${esc(value)}</textarea>`;
}

export function brandingCard(branding: Branding, on: boolean): string {
  return `
    <div class="card branding-card" id="branding-card"${on ? "" : " hidden"}>
      <div class="card-header"><h2>Theme &amp; Branding</h2></div>
      <div class="tweak-list">
      <div class="tweak-row${branding.customLogo ? " is-enabled" : ""}">
        <div class="tweak-body">${brandingSwitch("customLogo", "Custom logo", branding)}
          <div class="tweak-note" id="branding-note-customLogo"><p>SVG, PNG or JPG up to 512 KB, used on every CloudPanel page and the login page. An empty slot keeps CloudPanel's own.</p></div>
          <div class="branding-tiles is-wide">${HEADER_TILES.map((t) => tile(t, branding)).join("")}
          </div>
          <div class="branding-tiles">${SQUARE_TILES.map((t) => tile(t, branding)).join("")}
          </div>
        </div>
      </div>
      <div class="tweak-row${branding.customCss ? " is-enabled" : ""}">
        <div class="tweak-body">${brandingSwitch("customCss", "Custom CSS", branding)}
          <div class="tweak-note" id="branding-note-customCss"><p>Loaded after CloudPanel's own styles on every page, the login page included.</p></div>
          ${editor("branding-css", "css", "Custom CSS", branding.css, 10, "/* Enter your custom CSS here */\nbody {\n  /* Your styles */\n}")}
          <div class="form-actions"><button class="btn btn-primary branding-save" type="button" data-target="branding-css"
            onclick="saveBrandingText(this)" disabled>Save</button></div>
        </div>
      </div>
      <div class="tweak-row${branding.showFooter ? " is-enabled" : ""}">
        <div class="tweak-body">${brandingSwitch("showFooter", "Show footer", branding)}
          <div class="tweak-note" id="branding-note-showFooter"><p>Display the footer on every page. Your own items replace CloudPanel's links; the language selector stays.</p></div>
          ${editor("branding-footer", "footerHtml", "Footer content (HTML)", branding.footerHtml, 6,
    '<li><a href="https://example.com/support">Support</a></li>\n<li>© Example Hosting</li>')}
          <p class="hint">Use <code>&lt;li&gt;</code> items to match the footer's design. Leave empty to keep CloudPanel's own links.</p>
          <div class="form-actions"><button class="btn btn-primary branding-save" type="button" data-target="branding-footer"
            onclick="saveBrandingText(this)" disabled>Save</button></div>
        </div>
      </div>
      </div>
    </div>`;
}
