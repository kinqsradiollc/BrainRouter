"use client";

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

export async function downloadPNGFromSVG(svg: string, w: number, h: number, name: string) {
  const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("render failed"));
    img.src = src;
  });
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, w, h);
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
