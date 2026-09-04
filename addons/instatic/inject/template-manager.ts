import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

export const CLP_TEMPLATES_DIR = "/home/clp/htdocs/app/files/templates";
export const CLP_TWIG_CACHE_DIR = "/home/clp/htdocs/app/files/var/cache/prod/twig";

export const HEADER_TEMPLATE = `${CLP_TEMPLATES_DIR}/Frontend/Partial/header.html.twig`;
export const NEW_SITE_TEMPLATE = `${CLP_TEMPLATES_DIR}/Frontend/Site/New/index.html.twig`;

const START_MARKER = "<!-- CLP-ADDONS-START: instatic -->";
const END_MARKER = "<!-- CLP-ADDONS-END: instatic -->";

const HEADER_SNIPPET = `
      ${START_MARKER}
      <a href="/instatic/" title="Instatic">Instatic</a>
      ${END_MARKER}`;

const NEW_SITE_SNIPPET = `
            ${START_MARKER}
            <div class="application">
              <div class="application-image">
                <svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect width="160" height="160" rx="24" fill="#0F172A"/>
                  <path d="M40 45h80v14H40V45zm0 28h80v14H40V73zm0 28h55v14H40v-14z" fill="#38BDF8"/>
                  <circle cx="115" cy="108" r="7" fill="#F43F5E"/>
                </svg>
              </div>
              <div class="deploy-application-container">
                <a href="/instatic/new" class="btn btn-white">Create an Instatic Site</a>
              </div>
            </div>
            ${END_MARKER}`;

export function purgeTwigCache(): void {
  try {
    if (existsSync(CLP_TWIG_CACHE_DIR)) {
      execSync(`rm -rf "${CLP_TWIG_CACHE_DIR}"/*`);
      console.log("[INFO] Twig cache purged successfully.");
    }
  } catch (err) {
    console.error("[WARN] Failed to purge Twig cache:", err);
  }
}

export function isTemplateInjected(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, "utf-8");
  return content.includes(START_MARKER);
}

export function injectHeader(): boolean {
  if (!existsSync(HEADER_TEMPLATE)) {
    console.error(`[ERROR] Header template not found at ${HEADER_TEMPLATE}`);
    return false;
  }

  const content = readFileSync(HEADER_TEMPLATE, "utf-8");
  if (content.includes(START_MARKER)) {
    console.log("[INFO] Header template already injected.");
    return true;
  }

  // Backup pristine copy
  const pristineBackup = `${HEADER_TEMPLATE}.clp-addons-pristine`;
  if (!existsSync(pristineBackup)) {
    copyFileSync(HEADER_TEMPLATE, pristineBackup);
  }

  // Inject into nav-link-container
  const targetTag = `<div class="nav-link-container w-100">`;
  const idx = content.indexOf(targetTag);
  if (idx === -1) {
    console.error("[ERROR] Could not find nav-link-container in header template");
    return false;
  }

  const insertPos = idx + targetTag.length;
  const updated = content.slice(0, insertPos) + HEADER_SNIPPET + content.slice(insertPos);
  writeFileSync(HEADER_TEMPLATE, updated, "utf-8");
  console.log("[INFO] Injected Instatic nav entry into header template.");
  return true;
}

export function injectNewSite(): boolean {
  if (!existsSync(NEW_SITE_TEMPLATE)) {
    console.error(`[ERROR] New site template not found at ${NEW_SITE_TEMPLATE}`);
    return false;
  }

  const content = readFileSync(NEW_SITE_TEMPLATE, "utf-8");
  if (content.includes(START_MARKER)) {
    console.log("[INFO] New site template already injected.");
    return true;
  }

  // Backup pristine copy
  const pristineBackup = `${NEW_SITE_TEMPLATE}.clp-addons-pristine`;
  if (!existsSync(pristineBackup)) {
    copyFileSync(NEW_SITE_TEMPLATE, pristineBackup);
  }

  // Inject into site-type-container
  const targetTag = `<div class="site-type-container">`;
  const idx = content.indexOf(targetTag);
  if (idx === -1) {
    console.error("[ERROR] Could not find site-type-container in new site template");
    return false;
  }

  const insertPos = idx + targetTag.length;
  const updated = content.slice(0, insertPos) + NEW_SITE_SNIPPET + content.slice(insertPos);
  writeFileSync(NEW_SITE_TEMPLATE, updated, "utf-8");
  console.log("[INFO] Injected Instatic card into new site template.");
  return true;
}

export function removeInjection(filePath: string): boolean {
  if (!existsSync(filePath)) return true;
  let content = readFileSync(filePath, "utf-8");
  if (!content.includes(START_MARKER)) return true;

  const regex = new RegExp(`\\s*${START_MARKER}[\\s\\S]*?${END_MARKER}\\s*`, "g");
  content = content.replace(regex, "\n");
  writeFileSync(filePath, content, "utf-8");
  console.log(`[INFO] Removed injection from ${filePath}`);
  return true;
}

export function injectAll(): boolean {
  const ok1 = injectHeader();
  const ok2 = injectNewSite();
  if (ok1 && ok2) {
    purgeTwigCache();
    return true;
  }
  return false;
}

export function removeAll(): boolean {
  const ok1 = removeInjection(HEADER_TEMPLATE);
  const ok2 = removeInjection(NEW_SITE_TEMPLATE);
  purgeTwigCache();
  return ok1 && ok2;
}
