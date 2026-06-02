"use client";

import { useState } from "react";
import { SIZES, type BrandConfig } from "./brandPresets";
import { buildPosterSVG } from "./buildPoster";

function triggerDownload(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Export the current poster as vector SVG, hi-res PNG (rasterized), or copy. */
export function useBrandExport(cfg: BrandConfig) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const base = `brainrouter-${cfg.preset}-${cfg.template}`;

  const downloadSVG = () => {
    const blob = new Blob([buildPosterSVG(cfg)], { type: "image/svg+xml;charset=utf-8" });
    triggerDownload(URL.createObjectURL(blob), `${base}.svg`);
  };

  const downloadPNG = async () => {
    setBusy(true);
    try {
      const { w, h } = SIZES[cfg.preset];
      const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(buildPosterSVG(cfg));
      const img = new Image();
      img.decoding = "sync";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("render failed"));
        img.src = src;
      });
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      await new Promise<void>((resolve) =>
        canvas.toBlob((blob) => {
          if (blob) triggerDownload(URL.createObjectURL(blob), `${base}.png`);
          resolve();
        }, "image/png")
      );
    } finally {
      setBusy(false);
    }
  };

  const copySVG = async () => {
    try {
      await navigator.clipboard.writeText(buildPosterSVG(cfg));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return { downloadSVG, downloadPNG, copySVG, busy, copied };
}
