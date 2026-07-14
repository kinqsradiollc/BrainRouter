"use client";

import { useState } from "react";
import { allowsRasterExport, dimsFor, type BrandConfig } from "./brandPresets";
import { buildSVG } from "./buildSVG";
import { downloadSVGString, downloadPNGFromSVG, copyText } from "./exportUtil";

/** Export the current asset as vector SVG, hi-res PNG (scale×), or copy. */
export function useBrandExport(cfg: BrandConfig) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const base = `brainrouter-${cfg.mode}`;

  const downloadSVG = () => downloadSVGString(buildSVG(cfg), `${base}.svg`);

  const downloadPNG = async (scale = 2) => {
    if (!allowsRasterExport(cfg.mode)) return;
    setBusy(true);
    try {
      const { w, h } = dimsFor(cfg);
      await downloadPNGFromSVG(buildSVG(cfg), w, h, `${base}.png`, scale);
    } finally {
      setBusy(false);
    }
  };

  const copySVG = async () => {
    if (await copyText(buildSVG(cfg))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return { downloadSVG, downloadPNG, copySVG, busy, copied };
}
