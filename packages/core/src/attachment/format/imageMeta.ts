/**
 * IMAGE-META (0.4.15) — dependency-free image sniffing for attachments.
 *
 * Detects the image format from magic bytes and reads the intrinsic pixel
 * dimensions straight out of the file header for PNG, GIF, BMP, JPEG, and
 * WEBP (VP8 / VP8L / VP8X). No decode, no `fs`, no network — just `Buffer`
 * reads guarded against the buffer length. Feeds `AttachmentRecord.width` /
 * `.height` / `.mimeType` (image case) in the CLI attachment store.
 *
 * Every helper is a pure function and MUST NEVER throw: malformed, truncated,
 * or unrecognized input returns `null` (or omits the dimension fields).
 */

export interface ImageMeta {
  /** MIME type derived from the magic bytes. */
  mime: string;
  /** Intrinsic pixel width, when it could be parsed from the header. */
  width?: number;
  /** Intrinsic pixel height, when it could be parsed from the header. */
  height?: number;
}

/** Read a big-endian uint32, or `undefined` if the range is out of bounds. */
function u32be(buf: Buffer, off: number): number | undefined {
  if (off < 0 || off + 4 > buf.length) return undefined;
  return buf.readUInt32BE(off);
}

/** Read a little-endian uint32, or `undefined` if out of bounds. */
function u32le(buf: Buffer, off: number): number | undefined {
  if (off < 0 || off + 4 > buf.length) return undefined;
  return buf.readUInt32LE(off);
}

/** Read a little-endian int32, or `undefined` if out of bounds. */
function i32le(buf: Buffer, off: number): number | undefined {
  if (off < 0 || off + 4 > buf.length) return undefined;
  return buf.readInt32LE(off);
}

/** Read a big-endian uint16, or `undefined` if out of bounds. */
function u16be(buf: Buffer, off: number): number | undefined {
  if (off < 0 || off + 2 > buf.length) return undefined;
  return buf.readUInt16BE(off);
}

/** Read a little-endian uint16, or `undefined` if out of bounds. */
function u16le(buf: Buffer, off: number): number | undefined {
  if (off < 0 || off + 2 > buf.length) return undefined;
  return buf.readUInt16LE(off);
}

/** True when `buf` starts with the given ASCII signature. */
function startsWith(buf: Buffer, sig: string): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffPng(buf: Buffer): ImageMeta | null {
  if (buf.length < PNG_SIG.length) return null;
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (buf[i] !== PNG_SIG[i]) return null;
  }
  // IHDR is the first chunk: 4-byte length, "IHDR", then width@16 height@20.
  const width = u32be(buf, 16);
  const height = u32be(buf, 20);
  const meta: ImageMeta = { mime: 'image/png' };
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    meta.width = width;
    meta.height = height;
  }
  return meta;
}

function sniffGif(buf: Buffer): ImageMeta | null {
  if (!startsWith(buf, 'GIF87a') && !startsWith(buf, 'GIF89a')) return null;
  const width = u16le(buf, 6);
  const height = u16le(buf, 8);
  const meta: ImageMeta = { mime: 'image/gif' };
  if (width !== undefined && height !== undefined) {
    meta.width = width;
    meta.height = height;
  }
  return meta;
}

function sniffBmp(buf: Buffer): ImageMeta | null {
  if (!startsWith(buf, 'BM')) return null;
  // BITMAPINFOHEADER: width@18, height@22 as signed int32 LE (height may be
  // negative for top-down bitmaps — report the absolute value).
  const width = i32le(buf, 18);
  const height = i32le(buf, 22);
  const meta: ImageMeta = { mime: 'image/bmp' };
  if (width !== undefined && height !== undefined) {
    meta.width = Math.abs(width);
    meta.height = Math.abs(height);
  }
  return meta;
}

function sniffJpeg(buf: Buffer): ImageMeta | null {
  // SOI marker.
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const meta: ImageMeta = { mime: 'image/jpeg' };

  let off = 2;
  // Walk the marker segments looking for a Start-Of-Frame.
  while (off + 1 < buf.length) {
    // Markers are 0xFF followed by a non-0x00, non-0xFF byte. Skip fill bytes.
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    let marker = buf[off + 1];
    // Consume any run of 0xFF padding bytes.
    let p = off + 1;
    while (marker === 0xff && p + 1 < buf.length) {
      p++;
      marker = buf[p];
    }
    off = p;

    // Standalone markers without a length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off++;
      continue;
    }

    const segLen = u16be(buf, off + 1);
    if (segLen === undefined || segLen < 2) break;

    // SOF0..SOF15 carry the frame dimensions, excluding the DHT/DAC/RST/SOI
    // family (0xC4 / 0xC8 / 0xCC). Layout: [precision@+3][height@+4][width@+6].
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // `off` is the marker byte here; the segment is
      // [len@+1..+2][precision@+3][height@+4..+5][width@+6..+7].
      const height = u16be(buf, off + 4);
      const width = u16be(buf, off + 6);
      if (width !== undefined && height !== undefined && width > 0 && height > 0) {
        meta.width = width;
        meta.height = height;
      }
      return meta;
    }

    // Advance past this segment: marker byte + 2 length bytes are at off..off+2,
    // and segLen counts the two length bytes, so the next marker is at
    // (off + 1) + segLen.
    off = off + 1 + segLen;
  }

  return meta;
}

function sniffWebp(buf: Buffer): ImageMeta | null {
  if (!startsWith(buf, 'RIFF')) return null;
  if (buf.length < 16) return null;
  if (
    buf[8] !== 0x57 || // 'W'
    buf[9] !== 0x45 || // 'E'
    buf[10] !== 0x42 || // 'B'
    buf[11] !== 0x50 // 'P'
  ) {
    return null;
  }

  const meta: ImageMeta = { mime: 'image/webp' };
  // FourCC of the first chunk at offset 12; chunk payload starts at 20.
  const fourcc = buf.toString('latin1', 12, Math.min(16, buf.length));

  if (fourcc === 'VP8 ') {
    // Lossy: keyframe header. Start code 0x9d 0x01 0x2a at payload+3, then
    // width@+6 and height@+8 as 14-bit little-endian values.
    const sc = 20 + 3;
    if (sc + 2 < buf.length && buf[sc] === 0x9d && buf[sc + 1] === 0x01 && buf[sc + 2] === 0x2a) {
      const w = u16le(buf, sc + 3);
      const h = u16le(buf, sc + 5);
      if (w !== undefined && h !== undefined) {
        meta.width = w & 0x3fff;
        meta.height = h & 0x3fff;
      }
    }
    return meta;
  }

  if (fourcc === 'VP8L') {
    // Lossless: 1 signature byte (0x2f) then a 32-bit LE field packing
    // (width-1) in 14 bits and (height-1) in the next 14 bits.
    const sig = 20;
    if (sig < buf.length && buf[sig] === 0x2f) {
      const bits = u32le(buf, sig + 1);
      if (bits !== undefined) {
        meta.width = (bits & 0x3fff) + 1;
        meta.height = ((bits >> 14) & 0x3fff) + 1;
      }
    }
    return meta;
  }

  if (fourcc === 'VP8X') {
    // Extended: 1 flags byte + 3 reserved, then canvas (width-1) and
    // (height-1) as 24-bit little-endian values at payload+4 and payload+7.
    const base = 20;
    if (base + 9 < buf.length) {
      const wm1 = buf[base + 4] | (buf[base + 5] << 8) | (buf[base + 6] << 16);
      const hm1 = buf[base + 7] | (buf[base + 8] << 8) | (buf[base + 9] << 16);
      meta.width = wm1 + 1;
      meta.height = hm1 + 1;
    }
    return meta;
  }

  // Recognized as WEBP but with an unknown leading chunk — still an image.
  return meta;
}

/**
 * Sniff an image's MIME type and intrinsic dimensions from its header bytes.
 *
 * Recognizes PNG, GIF (87a/89a), BMP, JPEG (via SOF markers), and WEBP
 * (VP8 / VP8L / VP8X). Returns `null` when the buffer is too short to classify
 * or does not match any supported signature. When the format is recognized but
 * the dimension fields cannot be read, `width`/`height` are omitted and only
 * `mime` is returned. Never throws.
 */
export function sniffImage(buf: Buffer): ImageMeta | null {
  if (!buf || buf.length < 2) return null;
  return (
    sniffPng(buf) ??
    sniffGif(buf) ??
    sniffBmp(buf) ??
    sniffWebp(buf) ??
    sniffJpeg(buf) ??
    null
  );
}
