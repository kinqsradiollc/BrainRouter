/**
 * INTERACTIVE PROTOTYPE — prompt builder + design-context steering (§3 D2 + D4).
 *
 * Pure, dependency-free core for the prototype-generation flow: turn a
 * requirement (or a Write-mode selection) into the instruction the agent follows
 * to emit a single self-contained interactive HTML file at a reserved, authorized
 * path, using the async-placeholder pattern for assets it can't inline, steered
 * by an optional design context (type / brand color / tone). The detection,
 * path-reservation, and placeholder primitives live in {@link ./protoDetect}; the
 * desktop poll loop + sandboxed-webview render (D3) consume both. All logic here
 * is unit-tested.
 */

import { makePlaceholderToken } from './protoDetect.js';

export interface DesignContext {
  /** A genre, e.g. 'dashboard', 'landing page', 'mobile app', 'settings screen'. */
  designType?: string;
  /** Primary brand color as a hex string (#rgb or #rrggbb). */
  brandColor?: string;
  /** Adjectives steering the feel, e.g. ['minimal', 'playful', 'high-contrast']. */
  tone?: string[];
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** True for a valid #rgb / #rrggbb hex color. */
export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value.trim());
}

/**
 * The design-steering block injected into the prototype prompt — one bullet per
 * provided field. Returns '' when no usable direction is given (so the prompt
 * stays clean). Invalid colors and blank tones are dropped.
 */
export function buildDesignSteering(design?: DesignContext | null): string {
  if (!design) return '';
  const lines: string[] = [];
  const type = design.designType?.trim();
  if (type) lines.push(`- Design type: ${type} — follow that genre's conventional layout, density, and components.`);
  if (design.brandColor && isHexColor(design.brandColor)) {
    lines.push(`- Primary brand color: ${design.brandColor.trim()} — use it for accents and primary actions; derive a tasteful neutral palette around it.`);
  }
  const tone = (design.tone ?? []).map((t) => t.trim()).filter(Boolean);
  if (tone.length) lines.push(`- Tone: ${tone.join(', ')} — let it drive typography, spacing, motion, and copy voice.`);
  if (!lines.length) return '';
  return ['Design direction (steer the look & feel):', ...lines].join('\n');
}

export interface PrototypePromptOptions {
  /** The feature/requirement to prototype (or a Write-mode selection). */
  requirement: string;
  /** The authorized output path (from `reservePrototypePath`). */
  reservedPath: string;
  /** Optional design steering. */
  design?: DesignContext | null;
  /**
   * Placeholder ids the host pre-reserved for async assets (images). When given,
   * the agent must use these exact tokens as `img` sources; the host resolves
   * them after the file is stable. When omitted, the agent inlines neutral SVG.
   */
  placeholders?: string[];
}

/**
 * The full instruction for an interactive-prototype turn: a single self-contained
 * HTML file at the reserved path, no network, genuinely interactive, ending at
 * `</html>` (so the stability watcher can swap it in), using the async-placeholder
 * pattern, optionally steered by a design context.
 */
export function buildPrototypePrompt(opts: PrototypePromptOptions): string {
  const steering = buildDesignSteering(opts.design);
  const placeholders = (opts.placeholders ?? []).filter((id) => id.trim());
  const placeholderNote = placeholders.length
    ? `For any image you cannot inline, use EXACTLY one of these placeholder tokens as the \`img\` src — they are resolved after you finish: ${placeholders.map((id) => makePlaceholderToken(id)).join(', ')}.`
    : 'For any image you cannot produce inline, use a neutral inline SVG placeholder — never an external URL.';
  return [
    'Build a single, self-contained, INTERACTIVE HTML prototype for the requirement below.',
    '',
    'Requirement:',
    opts.requirement.trim(),
    '',
    'Hard rules:',
    `- Write the ENTIRE prototype to exactly this path (and nowhere else): ${opts.reservedPath}`,
    '- One file: inline ALL CSS and JavaScript. No external network requests, CDNs, fonts, or analytics.',
    '- It must be genuinely interactive — working controls, state, and feedback — not a static mockup.',
    '- End the file with `</html>` and write nothing after it (a watcher swaps it in once the file is byte-stable).',
    `- ${placeholderNote}`,
    ...(steering ? ['', steering] : []),
  ].join('\n');
}
