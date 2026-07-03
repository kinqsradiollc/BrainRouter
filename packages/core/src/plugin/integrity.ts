/**
 * PLUGIN-MARKETPLACE P3 — integrity verification (plan §3.7.2).
 *
 * Remote installs verify the `integrity` sha256 declared by the registry entry
 * against the fetched artifact; a mismatch ABORTS the install (the atomic-staging
 * guarantee then leaves any prior version intact). Git installs pin a
 * ref/revision instead of a hash (handled by P2's install path).
 *
 * The digest format mirrors SRI: `sha256-<base64>` OR a bare hex string. We
 * accept both and normalize before comparing. This module is PURE hashing — no
 * network — so it is trivially testable over a Buffer/string.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Compute the sha256 of a buffer/string as `sha256-<base64>` (SRI form). */
export function sha256Integrity(data: Buffer | string): string {
  const hash = createHash('sha256').update(data).digest('base64');
  return `sha256-${hash}`;
}

/** Compute the sha256 of a buffer/string as a bare lowercase hex digest. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Normalize a declared integrity string to a comparable pair. Accepts:
 *   - `sha256-<base64>`  → { algo: 'sha256', base64 }
 *   - `<hex>`            → { algo: 'sha256', hex }  (bare 64-char hex)
 * Returns null for an unrecognized / unsupported algorithm.
 */
function normalize(value: string): { base64?: string; hex?: string } | null {
  const s = value.trim();
  if (!s) return null;
  const m = s.match(/^([a-z0-9]+)-(.+)$/i);
  if (m) {
    if (m[1].toLowerCase() !== 'sha256') return null; // only sha256 supported
    return { base64: m[2].trim() };
  }
  if (/^[a-f0-9]{64}$/i.test(s)) return { hex: s.toLowerCase() };
  return null;
}

export interface IntegrityResult {
  ok: boolean;
  /** The expected digest (as declared). */
  expected: string;
  /** The computed digest (`sha256-<base64>`). */
  actual: string;
  /** Explanation when `ok` is false. */
  message?: string;
}

/**
 * Verify `data` against a declared `integrity` string. When the declared value
 * is EMPTY/undefined we treat it as "no integrity pin" and pass (a git-pinned
 * source carries its own guarantee) — the caller decides whether an unpinned
 * remote source is acceptable. A malformed / unsupported digest FAILS closed.
 */
export function verifyIntegrity(data: Buffer | string, integrity: string | undefined): IntegrityResult {
  const actual = sha256Integrity(data);
  const declared = (integrity ?? '').trim();
  if (!declared) return { ok: true, expected: '', actual };

  const norm = normalize(declared);
  if (!norm) {
    return { ok: false, expected: declared, actual, message: `unsupported/malformed integrity "${declared}" (expected sha256-<base64> or 64-char hex)` };
  }
  const matches = norm.base64
    ? actual === `sha256-${norm.base64}`
    : sha256Hex(data) === norm.hex;
  if (matches) return { ok: true, expected: declared, actual };
  return { ok: false, expected: declared, actual, message: `integrity mismatch: expected ${declared}, got ${actual}` };
}

/**
 * Compare an already-computed `sha256-<base64>` digest against a declared
 * integrity string (which may be `sha256-<base64>` or bare hex). Empty declared
 * ⇒ pass (no pin). Used when the digest was produced by `hashDirectory` (a tree,
 * not a single artifact) so we don't re-hash. Returns the same `IntegrityResult`.
 */
export function compareDigest(actualSri: string, integrity: string | undefined): IntegrityResult {
  const actual = actualSri.trim();
  const declared = (integrity ?? '').trim();
  if (!declared) return { ok: true, expected: '', actual };
  const norm = normalize(declared);
  if (!norm) {
    return { ok: false, expected: declared, actual, message: `unsupported/malformed integrity "${declared}"` };
  }
  // Normalize the declared value to `sha256-<base64>` for comparison.
  let expectedSri: string;
  if (norm.base64) {
    expectedSri = `sha256-${norm.base64}`;
  } else {
    // Declared as hex → convert to base64 SRI form.
    expectedSri = `sha256-${Buffer.from(norm.hex ?? '', 'hex').toString('base64')}`;
  }
  if (actual === expectedSri) return { ok: true, expected: declared, actual };
  return { ok: false, expected: declared, actual, message: `integrity mismatch: expected ${declared}, got ${actual}` };
}

/**
 * Deterministic content digest of a DIRECTORY tree (for verifying a fetched
 * plugin against a registry `integrity` when there's no single artifact file —
 * e.g. a locally-staged copy). Files are visited in a stable sorted order;
 * `.git` / `node_modules` and the volatile `install.json` provenance file are
 * excluded so the hash is reproducible across installs. Returns `sha256-<base64>`.
 */
export function hashDirectory(dir: string, opts: { exclude?: readonly string[] } = {}): string {
  const exclude = new Set(['.git', 'node_modules', 'install.json', ...(opts.exclude ?? [])]);
  const hash = createHash('sha256');
  const walk = (cur: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    const sorted = entries
      .filter((e) => !exclude.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      const full = path.join(cur, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        hash.update(`D:${relPath}\n`);
        walk(full, relPath);
      } else if (e.isFile()) {
        hash.update(`F:${relPath}\n`);
        try { hash.update(fs.readFileSync(full)); } catch { /* ignore */ }
        hash.update('\n');
      }
    }
  };
  walk(dir, '');
  return `sha256-${hash.digest('base64')}`;
}
