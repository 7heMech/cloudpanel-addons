// The logos and favicon Theme & Branding puts on CloudPanel's pages, the login
// page among them, so they are answered before the session gate. Anything
// that is not an image a branding slot names returns null and meets the gate.

import { ADDONS_BASE_PATH, mountPath } from "../../../lib/mount";
import { ASSET_NAME_RE } from "../branding";
import { panelTweaksService } from "./service";

export const BRANDING_ASSET_PREFIX = `${mountPath("panel-tweaks").slice(ADDONS_BASE_PATH.length)}/branding/`;

export async function handleBrandingAsset(req: Request, path: string): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const name = path.slice(BRANDING_ASSET_PREFIX.length);
  if (!ASSET_NAME_RE.test(name)) return null;
  const result = await panelTweaksService.brandingAsset(name);
  if (!result.ok || !result.data) return null;
  return new Response(req.method === "HEAD" ? null : Buffer.from(result.data.data, "base64"), {
    headers: {
      "Content-Type": result.data.type,
      // Named by its content, so it never changes under the same URL.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // An SVG opened on its own runs nothing and loads nothing.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
