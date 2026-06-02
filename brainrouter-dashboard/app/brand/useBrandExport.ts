"use client";

import { useState } from "react";
import { dimsFor, type BrandConfig } from "./brandPresets";
import { buildSVG } from "./buildSVG";

function triggerDownload(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Export the current asset as vector SVG, hi-res PNG (rasterized), or copy. */
export function useBrandExport(cfg: BrandConfig) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const base = cfg.mode === "poster" ? `brainrouter-${cfg.preset}-${cfg.template}` : `brainrouter-${cfg.mode}`;

  const downloadSVG = () => {
    const blob = new Blob([buildSVG(cfg)], { type: "image/svg+xml;charset=utf-8" });
    triggerDownload(URL.createObjectURL(blob), `${base}.svg`);
  };

  const downloadPNG = async () => {
    setBusy(true);
    try {
      const { w, h } = dimsFor(cfg);
      const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(buildSVG(cfg));
      const img = new Image();
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
      await navigator.clipboard.writeText(buildSVG(cfg));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };

  return { downloadSVG, downloadPNG, copySVG, busy, copied };
}
