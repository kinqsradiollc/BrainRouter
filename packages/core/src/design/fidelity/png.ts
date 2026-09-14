/**
 * A small PNG codec (ADR-056 D-B7) — enough for screenshots and comps:
 * 8-bit grayscale / RGB / palette / gray+alpha / RGBA, non-interlaced, the five
 * scanline filters. Decodes to RGBA; encodes RGBA with filter 0. Pure Node
 * (zlib), no native dependency — the fidelity measurement must run wherever
 * the agent runs. Anything else (16-bit, interlaced, APNG) throws a clear error.
 */
import zlib from 'node:zlib';

export interface RgbaImage { width: number; height: number; data: Uint8Array }

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(buf: Uint8Array): boolean {
  return buf.length >= 8 && SIG.every((b, i) => buf[i] === b);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Uint8Array): RgbaImage {
  if (!isPng(buf)) throw new Error('not a PNG (bad signature)');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= buf.length) {
    const len = view.getUint32(pos); const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const start = pos + 8; const end = start + len;
    if (end > buf.length) throw new Error('truncated PNG');
    if (type === 'IHDR') {
      width = view.getUint32(start); height = view.getUint32(start + 4);
      bitDepth = buf[start + 8]; colorType = buf[start + 9]; interlace = buf[start + 12];
    } else if (type === 'PLTE') palette = buf.subarray(start, end);
    else if (type === 'IDAT') idat.push(buf.subarray(start, end));
    else if (type === 'IEND') break;
    pos = end + 4;
  }
  if (!width || !height) throw new Error('PNG has no IHDR');
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8-bit)`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('palette PNG without PLTE');
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total); let o = 0; for (const c of idat) { joined.set(c, o); o += c.length; }
  const raw = zlib.inflateSync(joined);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG image data is short');
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride); const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const x = raw[rowStart + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4; const s = x * channels;
      if (colorType === 0) { out[p] = out[p + 1] = out[p + 2] = cur[s]; out[p + 3] = 255; }
      else if (colorType === 2) { out[p] = cur[s]; out[p + 1] = cur[s + 1]; out[p + 2] = cur[s + 2]; out[p + 3] = 255; }
      else if (colorType === 3) { const i = cur[s] * 3; out[p] = palette![i]; out[p + 1] = palette![i + 1]; out[p + 2] = palette![i + 2]; out[p + 3] = 255; }
      else if (colorType === 4) { out[p] = out[p + 1] = out[p + 2] = cur[s]; out[p + 3] = cur[s + 1]; }
      else { out[p] = cur[s]; out[p + 1] = cur[s + 1]; out[p + 2] = cur[s + 2]; out[p + 3] = cur[s + 3]; }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA → PNG (colour type 6, filter 0 per row). */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
  const ihdr = new Uint8Array(13); const v = new DataView(ihdr.buffer);
  v.setUint32(0, width); v.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Uint8Array.from(SIG), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(zlib.deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}
