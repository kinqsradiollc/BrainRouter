"use client";

/**
 * Asset export. PNG is rasterized at `scale`× the design size: the SVG's root
 * width/height are enlarged while the viewBox is kept, so the vector
 * re-rasterizes crisp at high resolution (no upscaling blur). Scale is clamped
 * so the longest edge stays ≤ 6000px.
 */

function trigger(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function downloadSVGString(svg: string, name: string) {
  trigger(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" })), name);
}

export async function downloadPNGFromSVG(svg: string, w: number, h: number, name: string, scale = 2) {
  const eff = Math.max(1, Math.min(scale, 6000 / Math.max(w, h)));
  const W = Math.round(w * eff);
  const H = Math.round(h * eff);
  // enlarge only the root <svg> width/height; viewBox (and thus coordinates) stay put
  const scaled = svg.replace(/<svg([^>]*?)\swidth="[^"]*"\sheight="[^"]*"/, `<svg$1 width="${W}" height="${H}"`);
  const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(scaled);
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("render failed"));
    img.src = src;
  });
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, W, H);
  await new Promise<void>((res) => canvas.toBlob((b) => { if (b) trigger(URL.createObjectURL(b), name); res(); }, "image/png"));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
