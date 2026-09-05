/**
 * `design.md` tokens for the design-system rules (ADR-056 D-B1).
 *
 * The workspace design artifact (rules 09 §7c — the format is the design
 * skill's, the location precedence is `design.md`, `.brainrouter/design.md`,
 * `docs/design.md`) may open with YAML frontmatter carrying tokens: `colors`,
 * `typography.<role>.fontFamily`, `rounded`. This reader turns them into the
 * allowed sets the `design-system-*` rules check against — the tokens become
 * NORMATIVE for the detector, which is the §7c reader gaining a second
 * consumer, not a second format. A workspace with no artifact, or one without
 * frontmatter, simply has no design-system rules to run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DESIGN_ARTIFACT_PATHS } from '../../workspace/designArtifact.js';
import { toHex } from './css.js';

export interface DesignSystemTokens {
  /** Workspace-relative path the tokens came from. */
  path: string;
  /** Lower-cased primary family names, e.g. `cormorant garamond`. */
  fonts: Set<string>;
  /** Normalised `#rrggbb` values. */
  colors: Set<string>;
  /** Raw radius values as written (`4px`, `0.5rem`, `999px`). */
  radii: Set<string>;
  /** Raw color values that could not be normalised (oklch, var()); kept so a rule can match them textually. */
  colorLiterals: Set<string>;
}

const MAX_FRONTMATTER = 64 * 1024;

/** Primary family of a `font-family` list, lower-cased and unquoted. */
export function primaryFamily(value: string): string {
  return value.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
}

function walk(v: unknown, onLeaf: (keyPath: string[], value: string) => void, keyPath: string[] = []): void {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, onLeaf, [...keyPath, k]);
  } else if (typeof v === 'string' || typeof v === 'number') {
    onLeaf(keyPath, String(v));
  }
}

/** Parse tokens out of a design document's text. Exported for tests; tolerant of missing/invalid frontmatter. */
export function parseDesignTokens(markdown: string, relPath = 'design.md'): DesignSystemTokens | null {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m || m[1].length > MAX_FRONTMATTER) return null;
  let doc: unknown;
  try { doc = parseYaml(m[1]); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  const t: DesignSystemTokens = { path: relPath, fonts: new Set(), colors: new Set(), radii: new Set(), colorLiterals: new Set() };
  const root = doc as Record<string, unknown>;
  walk(root.colors, (_k, value) => { const hex = toHex(value); if (hex) t.colors.add(hex); else t.colorLiterals.add(value.trim().toLowerCase()); });
  walk(root.typography, (keyPath, value) => { if (keyPath[keyPath.length - 1] === 'fontFamily') t.fonts.add(primaryFamily(value)); });
  walk(root.rounded, (_k, value) => t.radii.add(value.trim().toLowerCase()));
  // Component tokens may reference `{colors.x}`; literals there count too.
  walk(root.components, (keyPath, value) => {
    const leaf = keyPath[keyPath.length - 1] ?? '';
    if (/color/i.test(leaf)) { const hex = toHex(value); if (hex) t.colors.add(hex); }
    if (leaf === 'rounded' && !/^\{/.test(value)) t.radii.add(value.trim().toLowerCase());
  });
  if (!t.fonts.size && !t.colors.size && !t.radii.size && !t.colorLiterals.size) return null;
  return t;
}

/** The workspace's tokens, from the first design artifact found; null when none carries tokens. Never throws. */
export function readDesignSystemTokens(workspaceRoot: string): DesignSystemTokens | null {
  for (const rel of DESIGN_ARTIFACT_PATHS) {
    const abs = path.join(workspaceRoot, rel);
    let raw: string;
    try { if (!fs.statSync(abs).isFile()) continue; raw = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const tokens = parseDesignTokens(raw, rel);
    if (tokens) return tokens;
  }
  return null;
}
