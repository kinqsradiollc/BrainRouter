import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { ROUTED_B_PATHS } from "../../../packages/brand/routedB";
import { buildAvatarSVG } from "./buildAvatar";
import { buildLogoSVG } from "./buildLogo";
import { allowsRasterExport, DEFAULT_CONFIG, type BrandConfig } from "./brandPresets";
import { buildEditorSVG } from "./editor/buildEditorSVG";
import { TEMPLATE_FACTORIES } from "./editor/templates";

const routedBPaths = Object.values(ROUTED_B_PATHS);

function assertCanonicalMark(svg: string): void {
  for (const path of routedBPaths) assert.match(svg, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("logo, avatar, and poster exports share the coded Routed B geometry", () => {
  const logo = buildLogoSVG({ ...DEFAULT_CONFIG, mode: "logo", lockup: "full" });
  const avatar = buildAvatarSVG({ ...DEFAULT_CONFIG, mode: "avatar" });
  assertCanonicalMark(logo);
  assertCanonicalMark(avatar);

  for (const template of TEMPLATE_FACTORIES.filter(({ key }) => key !== "blank")) {
    assertCanonicalMark(buildEditorSVG(template.make()));
  }
});

test("default Brand Studio exports use flat neutral primary colors", () => {
  const exports = [
    buildLogoSVG({ ...DEFAULT_CONFIG, mode: "logo", lockup: "full" }),
    buildAvatarSVG({ ...DEFAULT_CONFIG, mode: "avatar" }),
    ...TEMPLATE_FACTORIES.filter(({ key }) => key !== "blank").map(({ make }) => buildEditorSVG(make())),
  ];

  for (const svg of exports) {
    assert.doesNotMatch(svg, /#34C28E|#42D6A0|#1E9E73|#7FE6BE|#2A9C74/i);
    assert.doesNotMatch(svg, /<(?:linear|radial)Gradient\b/i);
  }
});

test("uploaded photos remain optional content, never the logo source", () => {
  const withPhoto: BrandConfig = {
    ...DEFAULT_CONFIG,
    mode: "avatar",
    imageDataUrl: "data:image/png;base64,photo-content",
  };
  const avatar = buildAvatarSVG(withPhoto);
  assert.match(avatar, /<image href="data:image\/png;base64,photo-content"/);
  assertCanonicalMark(avatar);
});

test("logo mode remains vector-only while composed assets keep raster export", () => {
  assert.equal(allowsRasterExport("logo"), false);
  assert.equal(allowsRasterExport("avatar"), true);
  assert.equal(allowsRasterExport("canvas"), true);
});

test("browser and install metadata use only the canonical coded vector mark", () => {
  const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8");
  const manifest = readFileSync(new URL("../../public/site.webmanifest", import.meta.url), "utf8");
  const icon = readFileSync(new URL("../../public/ico.svg", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("../../components/Sidebar.tsx", import.meta.url), "utf8");

  assertCanonicalMark(icon);
  assert.doesNotMatch(`${layout}\n${manifest}`, /\.(?:ico|png|jpe?g|webp|avif)\b/i);
  assert.doesNotMatch(icon, /#(?:34C28E|42D6A0|06120D)|<(?:linear|radial)Gradient\b|<image\b/i);
  assert.match(layout, /\/ico\.svg/);
  assert.match(manifest, /"src"\s*:\s*"\/ico\.svg"/);
  // The sidebar head is the workspace switcher now, not a brand lockup, so
  // there is no `<BrainRouterLogo showWordmark={false}>` left to assert. What
  // still matters — and is what this test was ever guarding — is that no raster
  // image and no hand-typed letterform stands in for the coded mark.
  assert.doesNotMatch(sidebar, /<img\b|<span className="sidebar-org-mark">B<\/span>/i);

  for (const asset of ["favicon.ico", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
    assert.equal(existsSync(new URL(`../../public/${asset}`, import.meta.url)), false, `${asset} must not ship as a logo dependency`);
  }
});

test("shared tokens map dashboard controls to 32px and desktop controls to 30px", () => {
  // Only the shared tokens and the dashboard's own use of them. This used to
  // reach across into `brainrouter-desktop/src/theme.css` to check the desktop
  // CONSUMED the token; a dashboard test reading another workspace's stylesheet
  // breaks on somebody else's refactor, which is what happened when the desktop
  // grew `src/styles/foundation/`.
  //
  // Nothing is unasserted as a result. The value still lives here (line below:
  // the shared token maps desktop controls to 30px), and the desktop asserts
  // that it consumes it — `--chrome-control-size: var(--control-size)`, and
  // `.rail-top .icon-btn` sized from it — in
  // `brainrouter-desktop/src/App/layout/shellLayoutContract.test.ts`.
  const shared = readFileSync(new URL("../../../packages/brand/tokens.css", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

  assert.match(shared, /--br-dashboard-control-size:\s*32px/);
  assert.match(shared, /--br-desktop-control-size:\s*30px/);
  assert.match(dashboard, /--control-size:\s*var\(--br-dashboard-control-size\)/);
});
