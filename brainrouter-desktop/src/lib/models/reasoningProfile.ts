/**
 * Per-MODEL-FAMILY reasoning profile — decides what reasoning control the
 * composer shows for the CURRENTLY SELECTED model, instead of one fixed
 * Low/Medium/High/Extra-high menu for everything. Families reason differently
 * (graded effort vs always-on vs binary on/off vs none), so the menu adapts:
 * pick a Claude / GPT-5 / GLM model and you get its graded tiers, pick gpt-4o
 * and the control disappears, pick deepseek-reasoner and it's locked "Always on".
 *
 * This is the UI/menu layer. The literal wire value is still decided by core's
 * resolveWireEffort (provider + model aware); these rules MIRROR the model-name
 * patterns in packages/core/src/provider/models/reasoning.ts so the chip and the
 * request agree. Renderer-local (like modelCapabilities) so it pulls no core
 * import into the bundle, and so it unit-tests under `tsx --test`.
 */
import { modelFamily } from './modelFamily.js';
import type { ModelPolicy, ModelReasoningEffort } from '@kinqs/brainrouter-types';

export type ReasoningControlKind = 'none' | 'always-on' | 'binary' | 'graded';
export type EffortLevel = ModelReasoningEffort;

export interface ReasoningOption {
  /** The canonical EffortLevel this option maps to (the session/wire value). */
  level: EffortLevel;
  /** Family-appropriate menu label ('On'/'Off' for binary, 'Extra high', …). */
  label: string;
}

export interface ReasoningProfile {
  /** Detected brand family (drives the icon/label), or null when unknown. */
  family: string | null;
  /** Which kind of reasoning control to render. */
  kind: ReasoningControlKind;
  /** Menu options to show (empty for 'none' / 'always-on'). */
  options: ReasoningOption[];
  /** Minimal reasoning level — the Fast target; mirrors core minimalReasoningEffort. */
  min: EffortLevel;
  /** True when the family natively accepts the `xhigh` tier. */
  xhigh: boolean;
  /** Locked pill label for non-choosable kinds ('Always on'), else null. */
  lockedLabel: string | null;
  /** Server policies are authoritative; custom/BYOK profiles are heuristic. */
  source: 'server' | 'inferred';
}

/** Lower-case + strip a `vendor/` prefix (matches core normalizeModelName). */
function bareName(model: string): string {
  const m = model.toLowerCase();
  return m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m;
}

// Non-reasoning chat/instruct models that REJECT or ignore reasoning effort —
// hide the control entirely. Conservative: only the clear cases (modern OpenAI
// chat models + any `*-chat` variant). Everything else falls through to graded
// (broad accept-and-ignore), preserving the prior "effort shown for all" default.
const NON_REASONING: RegExp[] = [
  /(?:^|-)chat(?:-latest)?$/,   // deepseek-chat, gpt-5-chat-latest, *-chat
  /^chatgpt/,
  /^gpt-4o/,
  /^gpt-4\.1/,
  /^gpt-4\.5/,
  /^gpt-4-turbo/,
  /^gpt-4-\d/,                  // gpt-4-0613, gpt-4-1106-preview, …
  /^gpt-4$/,
  /^gpt-3\.5/,
];

// Models that natively accept the `xhigh` tier (mirror core XHIGH_CAPABLE).
const XHIGH: RegExp[] = [/^gpt-5\.1-codex-max/, /^gpt-5\.[2-9]/];

const GRADED_LABELS: Record<EffortLevel, string> = {
  none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};

// Custom Claude ids use a conservative inferred scale. Managed Claude/Fable
// models always use the exact server policy instead.
const CLAUDE_OPTIONS: ReasoningOption[] = [
  { level: 'low', label: 'Low' },
  { level: 'medium', label: 'Medium' },
  { level: 'high', label: 'High' },
  { level: 'xhigh', label: 'Extra' },
  { level: 'max', label: 'Max' },
];

function classify(m: string): ReasoningControlKind {
  if (NON_REASONING.some((re) => re.test(m))) return 'none';
  if (/^deepseek-reasoner/.test(m)) return 'always-on';
  if (/qat/.test(m)) return 'binary';
  return 'graded';
}

/** The reasoning profile for a model id (the composer's currently-active model). */
export function reasoningProfileForModel(model: string | undefined | null, policy?: ModelPolicy | null): ReasoningProfile {
  const raw = (model ?? '').trim();
  const family = raw ? modelFamily(raw) : null;
  if (policy) {
    if (!policy.capabilities.reasoning || !policy.reasoning) {
      return { family, kind: 'none', options: [], min: 'medium', xhigh: false, lockedLabel: null, source: 'server' };
    }
    const options = policy.reasoning.allowed.map(({ id, label }) => ({ level: id, label }));
    if (options.length === 1) {
      return {
        family,
        kind: 'always-on',
        options: [],
        min: options[0].level,
        xhigh: options[0].level === 'xhigh' || options[0].level === 'max',
        lockedLabel: options[0].label,
        source: 'server',
      };
    }
    return {
      family,
      kind: options.length ? 'graded' : 'none',
      options,
      min: options[0]?.level ?? 'medium',
      xhigh: options.some(({ level }) => level === 'xhigh' || level === 'max'),
      lockedLabel: null,
      source: 'server',
    };
  }
  if (!raw) {
    return { family, kind: 'none', options: [], min: 'medium', xhigh: false, lockedLabel: null, source: 'inferred' };
  }
  const m = bareName(raw);
  if (family === 'claude') {
    return { family, kind: 'graded', options: CLAUDE_OPTIONS, min: 'low', xhigh: true, lockedLabel: null, source: 'inferred' };
  }
  const kind = classify(m);

  if (kind === 'none') {
    return { family, kind, options: [], min: 'medium', xhigh: false, lockedLabel: null, source: 'inferred' };
  }
  if (kind === 'always-on') {
    return { family, kind, options: [], min: 'medium', xhigh: false, lockedLabel: 'Always on', source: 'inferred' };
  }
  if (kind === 'binary') {
    return {
      family, kind, min: 'medium', xhigh: false, lockedLabel: null, source: 'inferred',
      options: [{ level: 'medium', label: 'Off' }, { level: 'high', label: 'On' }],
    };
  }
  // graded
  const xhigh = XHIGH.some((re) => re.test(m));
  const levels: EffortLevel[] = xhigh ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'];
  return {
    family, kind, min: 'low', xhigh, lockedLabel: null, source: 'inferred',
    options: levels.map((level) => ({ level, label: GRADED_LABELS[level] })),
  };
}

/**
 * The label for the effort PILL given the active effort + Fast state. Returns
 * null when there's no reasoning control to show (kind 'none').
 */
export function reasoningPillLabel(profile: ReasoningProfile, effort: string, fast: boolean): string | null {
  if (profile.kind === 'none') return null;
  if (fast) return 'Fast';                                  // Fast = minimal reasoning
  if (profile.kind === 'always-on') return profile.lockedLabel;   // 'Always on'
  if (profile.kind === 'binary') return effort === 'medium' ? 'Off' : 'On';
  // graded: prefer the family's own stop label. When the stored effort isn't a stop for this model (e.g. xhigh
  // on a non-xhigh model) clamp the display to the top stop.
  const opt = profile.options.find((o) => o.level === effort);
  if (opt) return opt.label;
  if (profile.options.length) return profile.options[profile.options.length - 1].label;
  return GRADED_LABELS[effort as EffortLevel] ?? (effort ? effort[0].toUpperCase() + effort.slice(1) : '');
}

const EFFORT_RANK: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/**
 * The slider STOP index for the active effort under this profile's options.
 * Binary maps medium→Off(0) and anything else→On(last). Graded matches the
 * exact stop; an effort with no stop (e.g. `xhigh` on a non-xhigh model) clamps
 * to the highest stop whose rank doesn't exceed it.
 */
export function sliderIndexForEffort(profile: ReasoningProfile, effort: string): number {
  const opts = profile.options;
  if (opts.length === 0) return 0;
  if (profile.kind === 'binary') return effort === 'medium' ? 0 : opts.length - 1;
  const exact = opts.findIndex((o) => o.level === effort);
  if (exact >= 0) return exact;
  const target = EFFORT_RANK[effort] ?? 1;
  let best = 0;
  for (let i = 0; i < opts.length; i++) {
    if ((EFFORT_RANK[opts[i].level] ?? 1) <= target) best = i;
  }
  return best;
}

/**
 * The stop LEVEL at a 0..1 drag position along the track — snaps to the nearest
 * stop (the levels are discrete). Returns null when there are no stops.
 */
export function effortAtSliderFraction(profile: ReasoningProfile, fraction: number): EffortLevel | null {
  const opts = profile.options;
  if (opts.length === 0) return null;
  const clamped = Math.max(0, Math.min(1, fraction));
  const idx = Math.round(clamped * (opts.length - 1));
  return opts[idx].level;
}
