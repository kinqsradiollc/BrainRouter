/**
 * DETECT (0.4.15) — dependency-free attachment kind + MIME classification.
 *
 * Decides an attachment's coarse {@link AttachmentKind} and MIME type from
 * three signals, in priority order:
 *   1. an explicit, specific caller-provided MIME type,
 *   2. magic bytes (`sniffImage` for images, `%PDF` for PDF),
 *   3. the file-name extension (image / pdf / code / text maps).
 *
 * Magic bytes win over a misleading extension (e.g. a PNG named `foo.txt` is
 * classified as an image). Unknown inputs fall back to `kind: 'file'` with the
 * caller's MIME or `application/octet-stream`. Pure, deterministic, never
 * throws. The durable record shape (`AttachmentRecord.kind` / `.mimeType`)
 * lives in `@kinqs/brainrouter-types`.
 */

import type { AttachmentKind } from '@kinqs/brainrouter-types';
import { sniffImage } from './imageMeta.js';

export interface DetectedType {
  kind: AttachmentKind;
  mime: string;
}

const PDF_MIME = 'application/pdf';
const OCTET_STREAM = 'application/octet-stream';

/** Extension → MIME for image formats we can also sniff/preview. */
const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
};

/**
 * Extensions classified as `code`, each mapped to a reasonable MIME type. Kept
 * as an explicit table so detection is deterministic and easy to audit.
 */
const CODE_EXT_MIME: Record<string, string> = {
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  mts: 'text/x-typescript',
  cts: 'text/x-typescript',
  js: 'text/javascript',
  jsx: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  py: 'text/x-python',
  pyi: 'text/x-python',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  hpp: 'text/x-c++',
  hh: 'text/x-c++',
  cpp: 'text/x-c++',
  cc: 'text/x-c++',
  cxx: 'text/x-c++',
  cs: 'text/x-csharp',
  rb: 'text/x-ruby',
  php: 'application/x-httpd-php',
  swift: 'text/x-swift',
  kt: 'text/x-kotlin',
  kts: 'text/x-kotlin',
  scala: 'text/x-scala',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  zsh: 'application/x-sh',
  fish: 'application/x-sh',
  ps1: 'application/x-powershell',
  sql: 'application/sql',
  json: 'application/json',
  jsonc: 'application/json',
  json5: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  css: 'text/css',
  scss: 'text/x-scss',
  sass: 'text/x-sass',
  less: 'text/x-less',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  xhtml: 'application/xhtml+xml',
  vue: 'text/x-vue',
  svelte: 'text/x-svelte',
  dart: 'text/x-dart',
  lua: 'text/x-lua',
  r: 'text/x-r',
  pl: 'text/x-perl',
  pm: 'text/x-perl',
  m: 'text/x-objectivec',
  mm: 'text/x-objectivec',
  groovy: 'text/x-groovy',
  gradle: 'text/x-groovy',
  ex: 'text/x-elixir',
  exs: 'text/x-elixir',
  erl: 'text/x-erlang',
  clj: 'text/x-clojure',
  hs: 'text/x-haskell',
  proto: 'text/x-protobuf',
  graphql: 'application/graphql',
  gql: 'application/graphql',
};

/**
 * Extensions classified as `text` (prose / config / data), mapped to a MIME
 * type. These are documents rather than source code.
 */
const TEXT_EXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  rst: 'text/x-rst',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  ini: 'text/plain',
  conf: 'text/plain',
  cfg: 'text/plain',
  env: 'text/plain',
  properties: 'text/plain',
  rtf: 'text/rtf',
  tex: 'text/x-tex',
  org: 'text/plain',
  adoc: 'text/plain',
  asciidoc: 'text/plain',
};

/** Lower-cased extension (no dot) from a file name, or '' when none. */
function extOf(name: string): string {
  if (!name) return '';
  // Strip any directory part, then take the last dotted segment.
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** A MIME is "specific" if it is non-empty and not the generic octet-stream. */
function isSpecificMime(mime: string | undefined): mime is string {
  if (!mime) return false;
  const m = mime.trim().toLowerCase();
  if (m.length === 0) return false;
  if (m === OCTET_STREAM) return false;
  if (m === 'application/binary' || m === 'binary/octet-stream') return false;
  return true;
}

/** Map a (specific) MIME type to a coarse {@link AttachmentKind}. */
function kindFromMime(mime: string): AttachmentKind {
  const m = mime.toLowerCase();
  if (m === PDF_MIME) return 'pdf';
  if (m.startsWith('image/')) return 'image';
  // Common code-ish MIME families.
  if (
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'application/javascript' ||
    m === 'text/javascript' ||
    m === 'application/sql' ||
    m === 'application/yaml' ||
    m === 'application/toml' ||
    m === 'text/css' ||
    m === 'text/html' ||
    m.startsWith('text/x-') ||
    m === 'application/graphql' ||
    m === 'application/x-sh' ||
    m === 'application/x-httpd-php'
  ) {
    return 'code';
  }
  if (m.startsWith('text/')) return 'text';
  return 'file';
}

/** Detect PDF from its `%PDF` signature (allowing a few leading bytes). */
function isPdfMagic(buf: Buffer): boolean {
  if (buf.length < 5) return false;
  // The spec allows up to ~1024 bytes of junk before %PDF; scan a small window.
  const windowEnd = Math.min(buf.length, 1024);
  const head = buf.toString('latin1', 0, windowEnd);
  return head.includes('%PDF-');
}

/**
 * Classify an attachment into a {@link DetectedType} ({@link AttachmentKind} +
 * MIME). Priority: explicit specific MIME → magic bytes → file extension →
 * generic `file`. Deterministic and never throws.
 */
export function detectKind(input: { name: string; mime?: string; buffer?: Buffer }): DetectedType {
  const name = typeof input?.name === 'string' ? input.name : '';
  const buffer = input?.buffer;

  // 1) Magic bytes take precedence over a (possibly misleading) extension and
  //    even an explicit MIME, since the bytes are ground truth.
  if (buffer && buffer.length > 0) {
    try {
      const img = sniffImage(buffer);
      if (img) return { kind: 'image', mime: img.mime };
      if (isPdfMagic(buffer)) return { kind: 'pdf', mime: PDF_MIME };
    } catch {
      // fall through to MIME / extension
    }
  }

  // 2) Explicit, specific MIME from the caller.
  if (isSpecificMime(input?.mime)) {
    const mime = input.mime.trim();
    return { kind: kindFromMime(mime), mime };
  }

  // 3) Extension-based classification.
  const ext = extOf(name);
  if (ext) {
    if (ext === 'pdf') return { kind: 'pdf', mime: PDF_MIME };
    const imageMime = IMAGE_EXT_MIME[ext];
    if (imageMime) return { kind: 'image', mime: imageMime };
    const codeMime = CODE_EXT_MIME[ext];
    if (codeMime) return { kind: 'code', mime: codeMime };
    const textMime = TEXT_EXT_MIME[ext];
    if (textMime) return { kind: 'text', mime: textMime };
  }

  // 4) Unknown — generic blob. Any caller MIME left here is non-specific
  //    (octet-stream/binary), so the generic fallback is correct.
  return { kind: 'file', mime: OCTET_STREAM };
}
