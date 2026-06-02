/** Dispatch the current Brand Studio mode to its SVG builder. Pure (no React). */

import type { BrandConfig } from "./brandPresets";
import { buildPosterSVG } from "./buildPoster";
import { buildAvatarSVG } from "./buildAvatar";
import { buildLogoSVG } from "./buildLogo";

export function buildSVG(cfg: BrandConfig): string {
  if (cfg.mode === "avatar") return buildAvatarSVG(cfg);
  if (cfg.mode === "logo") return buildLogoSVG(cfg);
  return buildPosterSVG(cfg);
}
