/**
 * Detector suppressions (ADR-056 D-B1): `.brainrouter/design-detector.json`.
 *
 * Workspace data — committed with the project, never a `cli.*` knob — because
 * a suppression is a statement about THIS codebase ("the live overlay owns its
 * own type scale") that every contributor and the review bot must share. Each
 * entry carries a `reason`; a suppression without one is still honoured but
 * reported, so silence is never invisible. A file from a repository can only
 * ever remove findings, never add rules.
 *
 *   {
 *     "ignoreRules":  ["overused-font"],
 *     "ignoreFiles":  ["tests/fixtures/**"],
 *     "ignoreValues": [{ "rule": "design-system-font-size", "value": "*", "files": ["src/overlay.js"], "reason": "…" }]
 *   }
 */
import fs from 'node:fs';
import path from 'node:path';

export interface DesignSuppressionValue { rule: string; value: string; files?: string[]; reason?: string }

export interface DesignSuppressions {
  ignoreRules: string[];
  ignoreFiles: string[];
  ignoreValues: DesignSuppressionValue[];
}

export const DESIGN_SUPPRESSIONS_FILE = path.join('.brainrouter', 'design-detector.json');
export const EMPTY_SUPPRESSIONS: DesignSuppressions = { ignoreRules: [], ignoreFiles: [], ignoreValues: [] };

const MAX_ENTRIES = 500;
const str = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_ENTRIES) : []);

/** Parse a suppressions document; unknown fields are ignored, bad shapes become empty. */
export function parseDesignSuppressions(raw: unknown): DesignSuppressions {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_SUPPRESSIONS };
  const r = raw as Record<string, unknown>;
  const ignoreValues = Array.isArray(r.ignoreValues)
    ? r.ignoreValues.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => ({ rule: String(e.rule ?? ''), value: String(e.value ?? '*'), ...(Array.isArray(e.files) ? { files: str(e.files) } : {}), ...(typeof e.reason === 'string' ? { reason: e.reason } : {}) }))
      .filter((e) => e.rule).slice(0, MAX_ENTRIES)
    : [];
  return { ignoreRules: str(r.ignoreRules), ignoreFiles: str(r.ignoreFiles), ignoreValues };
}

/** The workspace's suppressions, or empty. Never throws. */
export function readDesignSuppressions(workspaceRoot: string): DesignSuppressions {
  try {
    return parseDesignSuppressions(JSON.parse(fs.readFileSync(path.join(workspaceRoot, DESIGN_SUPPRESSIONS_FILE), 'utf8')) as unknown);
  } catch {
    return { ...EMPTY_SUPPRESSIONS };
  }
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. Paths are POSIX, workspace-relative. */
export function globMatch(pattern: string, filePath: string): boolean {
  // Placeholders keep the later single-star pass from rewriting the regex text
  // substituted for `**` (which itself contains a star).
  const DEEP = '\u0000D\u0000', ANY = '\u0000A\u0000';
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, DEEP)
    .replace(/\*\*/g, ANY)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(DEEP).join('(?:.*/)?')
    .split(ANY).join('.*');
  return new RegExp(`^${re}$`).test(filePath);
}

/** Is a finding suppressed? `value` is the rule's matched value (font name, colour, …) when it has one. */
export function isSuppressed(s: DesignSuppressions, rule: string, filePath: string, value?: string): { suppressed: boolean; reason?: string } {
  if (s.ignoreRules.includes(rule)) return { suppressed: true, reason: 'ignoreRules' };
  if (s.ignoreFiles.some((g) => globMatch(g, filePath))) return { suppressed: true, reason: 'ignoreFiles' };
  for (const v of s.ignoreValues) {
    if (v.rule !== rule) continue;
    if (v.value !== '*' && (value === undefined || v.value.toLowerCase() !== value.toLowerCase())) continue;
    if (v.files?.length && !v.files.some((g) => globMatch(g, filePath))) continue;
    return { suppressed: true, reason: v.reason ?? 'ignoreValues (no reason given)' };
  }
  return { suppressed: false };
}
