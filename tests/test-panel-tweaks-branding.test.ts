import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePanelTweaksAction, type PanelTweaksActionOptions, type SetBrandingResult, type SetTweaksResult } from "../addons/panel-tweaks/action";
import { DEFAULT_BRANDING, type Branding } from "../addons/panel-tweaks/branding";
import { brandingFooterSnippet, brandingHeadSnippet } from "../addons/panel-tweaks/inject/branding";
import { PANEL_TWEAKS_TARGETS } from "../addons/panel-tweaks/inject/targets";
import { BRANDING_ASSET_PREFIX, handleBrandingAsset } from "../addons/panel-tweaks/app/branding-asset";
import { panelTweaksService } from "../addons/panel-tweaks/app/service";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]).toString("base64");
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>').toString("base64");

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function options(input?: unknown): PanelTweaksActionOptions {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "clp-branding-"));
  return {
    processUid: 0,
    emitReply: false,
    input: input === undefined ? undefined : JSON.stringify(input),
    paths: {
      tweaksFile: join(dir, "tweaks.json"),
      lockFile: join(dir, "tweaks.lock"),
      brandingFile: join(dir, "branding.json"),
      brandingDir: join(dir, "branding"),
      rootUid: process.getuid?.() ?? 0,
    },
  };
}

function act<T>(argv: string[], input?: unknown): Promise<T> {
  return executePanelTweaksAction(argv, options(input)) as Promise<T>;
}

function branding(extra: Partial<Branding> = {}): Branding {
  return { ...DEFAULT_BRANDING, logos: { ...DEFAULT_BRANDING.logos }, ...extra };
}

test("branding is off by default and moving its switch renders the templates again", async () => {
  expect((await act<Branding>(["branding"]))).toEqual(DEFAULT_BRANDING);
  const on = await act<SetTweaksResult>(["set-tweaks"], { branding: true });
  expect(on.tweaks.branding).toBe(true);
  expect(on.reinject).toBe(true);
});

test("a settings change reinjects only while the switch is on", async () => {
  const off = await act<SetBrandingResult>(["set-branding"], { customCss: true, css: "body { color: red; }" });
  expect(off.reinject).toBe(false);
  expect(off.branding.css).toBe("body { color: red; }");
  await act(["set-tweaks"], { branding: true });
  expect((await act<SetBrandingResult>(["set-branding"], { showFooter: false })).reinject).toBe(true);
  // The earlier setting is still there beside the new one.
  expect((await act<Branding>(["branding"])).css).toBe("body { color: red; }");
});

test("nothing that would end Twig's verbatim block is accepted", async () => {
  await expect(act(["set-branding"], { css: "a{} {% endverbatim %}{{ app }}" })).rejects.toThrow("endverbatim");
  await expect(act(["set-branding"], { footerHtml: "<li>{%- EndVerbatim -%}</li>" })).rejects.toThrow("endverbatim");
  await expect(act(["set-branding"], {})).rejects.toThrow("no branding setting");
  await expect(act(["set-branding"], { customLogo: "yes" })).rejects.toThrow("true or false");
});

test("an image is stored by its content, checked by its bytes, and the old one removed", async () => {
  const first = await act<SetBrandingResult>(["set-branding"], { logo: { slot: "headerLight", data: PNG } });
  expect(first.branding.logos.headerLight).toMatch(/^[0-9a-f]{64}\.png$/);
  const second = await act<SetBrandingResult>(["set-branding"], { logo: { slot: "headerLight", data: SVG } });
  expect(second.branding.logos.headerLight).toMatch(/\.svg$/);
  expect(readdirSync(join(dir, "branding"))).toEqual([second.branding.logos.headerLight]);

  const cleared = await act<SetBrandingResult>(["set-branding"], { logo: { slot: "headerLight", data: "" } });
  expect(cleared.branding.logos.headerLight).toBe("");
  expect(readdirSync(join(dir, "branding"))).toEqual([]);

  const text = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
  await expect(act(["set-branding"], { logo: { slot: "headerDark", data: text } })).rejects.toThrow("must be SVG, PNG, JPG");
  const ico = Buffer.from([0, 0, 1, 0, 1, 0]).toString("base64");
  await expect(act(["set-branding"], { logo: { slot: "headerDark", data: ico } })).rejects.toThrow("must be");
  expect((await act<SetBrandingResult>(["set-branding"], { logo: { slot: "favicon", data: ico } })).branding.logos.favicon)
    .toMatch(/\.ico$/);
  await expect(act(["set-branding"], { logo: { slot: "nope", data: PNG } })).rejects.toThrow("logo.slot");
});

test("an SVG that could run anything is refused", async () => {
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
  ]) {
    await expect(act(["set-branding"], { logo: { slot: "markLight", data: Buffer.from(svg).toString("base64") } }))
      .rejects.toThrow("SVG");
  }
});

test("only an image a slot names is served, and only to a well-formed name", async () => {
  const stored = await act<SetBrandingResult>(["set-branding"], { logo: { slot: "favicon", data: PNG } });
  const name = stored.branding.logos.favicon;
  const asset = await act<{ type: string; data: string }>(["branding-asset", `--name=${name}`]);
  expect(asset).toEqual({ type: "image/png", data: PNG });
  await expect(act(["branding-asset", `--name=${"0".repeat(64)}.png`])).rejects.toThrow("no such");
  await expect(act(["branding-asset", "--name=../branding.json"])).rejects.toThrow("not a branding image");
});

test("the public route answers an image with a sandboxing policy, and anything else meets the gate", async () => {
  const original = panelTweaksService.brandingAsset;
  const name = `${"a".repeat(64)}.svg`;
  panelTweaksService.brandingAsset = async (asked) => asked === name
    ? { ok: true, data: { type: "image/svg+xml", data: SVG } }
    : { ok: false, error: "no such branding image" };
  try {
    const hit = await handleBrandingAsset(new Request(`http://x/addons${BRANDING_ASSET_PREFIX}${name}`), `${BRANDING_ASSET_PREFIX}${name}`);
    expect(hit!.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(hit!.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(hit!.headers.get("Cache-Control")).toContain("immutable");
    expect(await handleBrandingAsset(new Request("http://x/"), `${BRANDING_ASSET_PREFIX}${"b".repeat(64)}.svg`)).toBeNull();
    expect(await handleBrandingAsset(new Request("http://x/"), `${BRANDING_ASSET_PREFIX}../tweaks.json`)).toBeNull();
    expect(await handleBrandingAsset(new Request("http://x/", { method: "POST" }), `${BRANDING_ASSET_PREFIX}${name}`)).toBeNull();
  } finally {
    panelTweaksService.brandingAsset = original;
  }
});

test("the head block is verbatim, names images under the mount, and keeps a stylesheet closed", () => {
  const name = `${"c".repeat(64)}.svg`;
  const head = brandingHeadSnippet("/addons/panel-tweaks", branding({
    customLogo: true,
    logos: { ...DEFAULT_BRANDING.logos, headerLight: name, favicon: name },
    customCss: true,
    css: "a { color: red } </style><script>x</script>",
  }));
  expect(head.startsWith("{% verbatim %}")).toBe(true);
  expect(head.endsWith("{% endverbatim %}")).toBe(true);
  expect(head).toContain(`<link rel="icon" type="image/svg+xml" href="/addons/panel-tweaks/branding/${name}" data-clp-tweaks>`);
  expect(head).toContain("data-light-img-src");
  expect(head).toContain("<\\/style><script>x</script>");
  expect(head.match(/<\/style>/g)).toHaveLength(1);
});

test("switches that are off leave nothing behind", () => {
  expect(brandingHeadSnippet("/addons/panel-tweaks", branding({ css: "a{}", logos: { ...DEFAULT_BRANDING.logos } }))).toBe("");
  expect(brandingHeadSnippet("/addons/panel-tweaks", branding({ showFooter: false }))).toContain("footer.footer { display: none");
  expect(brandingFooterSnippet(branding({ footerHtml: "<li>x</li>", showFooter: false }))).toBe("");
  expect(brandingFooterSnippet(branding())).toBe("");
});

test("the footer's own items keep the language selector and the update button", () => {
  const footer = brandingFooterSnippet(branding({ footerHtml: "<li>© Example</li>" }));
  expect(footer).toContain('<li class="clp-tweaks-footer" hidden></li><li>© Example</li>');
  expect(footer).toContain("update-available-button");
  const head = brandingHeadSnippet("/addons/panel-tweaks", branding({ footerHtml: "<li>© Example</li>" }));
  expect(head).toContain("li:not(.locale-selector)");
});

test("the blocks go into all three layouts and the footer, none of them required", () => {
  const targets = PANEL_TWEAKS_TARGETS.filter((target) => target.slug.startsWith("branding-"));
  expect(targets.map((target) => target.template).sort()).toEqual([
    "Admin/layout.html.twig", "Frontend/Login/layout.html.twig", "Frontend/layout.html.twig", "Partial/footer.html.twig",
  ]);
  expect(targets.every((target) => !target.required)).toBe(true);
});
