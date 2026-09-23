/**
 * ADR-055 P1 (D2a) — let a vision-capable model SEE a browser screenshot.
 *
 * `browser_screenshot` saves a PNG under `.brainrouter/browser/screenshots/`
 * and returns a small JSON result naming the path (it never inlines the bytes,
 * which would blow the transcript and the tool-result clamp). This helper turns
 * that path back into image bytes so the turn loop can attach them to a
 * companion `role:'user'` message — the only wire shape that carries an image
 * across every provider (OpenAI `image_url`, native Anthropic/Gemini blocks).
 *
 * It is deliberately advisory: any parse/containment/read failure returns null
 * and the turn continues on the text-only path. Node `fs` is used, so this is a
 * turn-loop module (never imported by the renderer).
 */
import fs from 'node:fs';
import path from 'node:path';

/** The subtree `browser_screenshot` writes into — the only path we will read. */
export const BROWSER_SCREENSHOT_DIR = '.brainrouter/browser/screenshots/';

/** Matches the desktop adapter's own artifact cap so a huge capture is dropped
 *  rather than sent. Kept as a local constant (never import desktop into core). */
export const MAX_BROWSER_VISION_BYTES = 8 * 1024 * 1024;

export interface BrowserVisionImage {
  mediaType: string;
  dataBase64: string;
}

/** Pull `{path}` out of a `browser_screenshot` result, tolerating the
 *  `{ok,kind,data:{path}}` envelope and a bare `{path}` object. */
function screenshotPathFromResult(resultText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return null;
  }
  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  if (!root) return null;
  const data = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;
  const value = data.path;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mediaTypeForPath(relative: string): string | null {
  const ext = path.extname(relative).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return null;
}

/**
 * If `name`/`resultText` name a browser screenshot inside the workspace, read
 * it and return its bytes for a vision message. Returns null (never throws) on
 * any failure — a wrong tool, an off-tree path, an oversized or unreadable
 * file, an unknown image type.
 */
export function browserScreenshotImageHandoff(
  name: string,
  resultText: string,
  workspaceRoot: string,
): BrowserVisionImage | null {
  if (name !== 'browser_screenshot') return null;
  if (!workspaceRoot || typeof resultText !== 'string') return null;

  const relative = screenshotPathFromResult(resultText);
  if (!relative) return null;
  // Fail closed on anything but a normal relative path in the screenshots dir.
  if (path.isAbsolute(relative) || relative.includes('..')) return null;
  const normalized = relative.split(path.sep).join('/');
  if (!normalized.startsWith(BROWSER_SCREENSHOT_DIR)) return null;

  const mediaType = mediaTypeForPath(normalized);
  if (!mediaType) return null;

  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(root, relative);
  // Re-validate containment after resolution (defence in depth vs. symlinks).
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) return null;
    if (stat.size <= 0 || stat.size > MAX_BROWSER_VISION_BYTES) return null;
    const bytes = fs.readFileSync(absolute);
    return { mediaType, dataBase64: bytes.toString('base64') };
  } catch {
    return null;
  }
}
