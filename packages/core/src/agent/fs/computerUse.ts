import type { ComputerUseAction, ComputerUseActionName } from '@kinqs/brainrouter-agent-protocol';

export const COMPUTER_USE_ACTIONS: readonly ComputerUseActionName[] = [
  'screenshot',
  'left_click',
  'right_click',
  'double_click',
  'move',
  'type',
  'key',
  'scroll',
  'drag',
];

export const MAX_SCROLL_CLICKS = 20;
export const MAX_TYPE_CHARS = 10_000;

export type ComputerUseValidation =
  | { ok: true; action: ComputerUseAction }
  | { ok: false; error: string };

export interface DestructiveComputerActionVerdict {
  dangerous: boolean;
  reason?: string;
}

const MUTATING_ACTIONS = new Set<ComputerUseActionName>([
  'left_click',
  'right_click',
  'double_click',
  'type',
  'key',
  'scroll',
  'drag',
]);

const DESTRUCTIVE_WORDS = /\b(delete|remove|destroy|drop|erase|send|submit|buy|purchase|pay|transfer|withdraw|confirm|sign|approve|publish|post)\b/i;
const SENSITIVE_APPS = /\b(mail|outlook|gmail|messages|slack|teams|discord|bank|broker|trading|wallet|paypal|stripe|venmo|cash|stocks?)\b/i;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requirePoint(input: ComputerUseAction, label: string): string | null {
  return finiteNumber(input.x) && finiteNumber(input.y)
    ? null
    : `${label} requires numeric x and y coordinates.`;
}

function normalizeClicks(value: unknown): number | undefined {
  if (!finiteNumber(value)) return undefined;
  return Math.max(1, Math.min(MAX_SCROLL_CLICKS, Math.floor(value)));
}

export function isComputerActionMutating(action: ComputerUseActionName): boolean {
  return MUTATING_ACTIONS.has(action);
}

export function validateComputerAction(input: unknown): ComputerUseValidation {
  if (!input || typeof input !== 'object') return { ok: false, error: 'computer_use requires an object argument.' };
  const raw = input as Record<string, unknown>;
  const action = raw.action;
  if (typeof action !== 'string' || !(COMPUTER_USE_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: `computer_use action must be one of: ${COMPUTER_USE_ACTIONS.join(', ')}.` };
  }
  const out: ComputerUseAction = { action: action as ComputerUseActionName };
  if (finiteNumber(raw.x)) out.x = raw.x;
  if (finiteNumber(raw.y)) out.y = raw.y;
  if (finiteNumber(raw.x2)) out.x2 = raw.x2;
  if (finiteNumber(raw.y2)) out.y2 = raw.y2;
  if (typeof raw.text === 'string') out.text = raw.text.slice(0, MAX_TYPE_CHARS);
  if (typeof raw.keys === 'string' || (Array.isArray(raw.keys) && raw.keys.every((k) => typeof k === 'string'))) out.keys = raw.keys as string | string[];
  if (typeof raw.direction === 'string' && ['up', 'down', 'left', 'right'].includes(raw.direction)) out.direction = raw.direction as ComputerUseAction['direction'];
  if (typeof raw.button === 'string' && ['left', 'right', 'middle'].includes(raw.button)) out.button = raw.button as ComputerUseAction['button'];
  if (Array.isArray(raw.hold_keys) && raw.hold_keys.every((k) => typeof k === 'string')) out.hold_keys = raw.hold_keys as string[];
  const clicks = normalizeClicks(raw.clicks);
  if (clicks !== undefined) out.clicks = clicks;

  switch (out.action) {
    case 'screenshot':
      return { ok: true, action: out };
    case 'move': {
      const err = requirePoint(out, 'move');
      return err ? { ok: false, error: err } : { ok: true, action: out };
    }
    case 'left_click':
    case 'right_click':
    case 'double_click': {
      const err = requirePoint(out, out.action);
      return err ? { ok: false, error: err } : { ok: true, action: out };
    }
    case 'type':
      return out.text ? { ok: true, action: out } : { ok: false, error: 'type requires non-empty text.' };
    case 'key':
      return out.keys ? { ok: true, action: out } : { ok: false, error: 'key requires keys as a string or string array.' };
    case 'scroll':
      return out.direction
        ? { ok: true, action: { ...out, clicks: out.clicks ?? 1 } }
        : { ok: false, error: 'scroll requires direction: up, down, left, or right.' };
    case 'drag': {
      const start = requirePoint(out, 'drag');
      if (start) return { ok: false, error: start };
      if (!finiteNumber(out.x2) || !finiteNumber(out.y2)) return { ok: false, error: 'drag requires numeric x2 and y2 coordinates.' };
      return { ok: true, action: out };
    }
    default:
      return { ok: false, error: `Unsupported computer_use action: ${(out as ComputerUseAction).action}` };
  }
}

export function expandChordKeys(keys: string | string[], opts: { platform?: NodeJS.Platform } = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const raw = Array.isArray(keys) ? keys : keys.split('+');
  return raw
    .flatMap((entry) => String(entry).split('+'))
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean)
    .map((key) => {
      const normalized = key === 'control' ? 'ctrl' : key === 'command' ? 'cmd' : key === 'option' ? 'alt' : key;
      return platform === 'darwin' && normalized === 'ctrl' ? 'cmd' : normalized;
    });
}

export function evaluateDestructiveAction(
  action: ComputerUseAction,
  context: { nearbyText?: string; frontmostApp?: string; userIntent?: string } = {},
): DestructiveComputerActionVerdict {
  if (!isComputerActionMutating(action.action)) return { dangerous: false };
  const nearby = `${context.nearbyText ?? ''} ${action.text ?? ''} ${Array.isArray(action.keys) ? action.keys.join(' ') : action.keys ?? ''}`;
  if (DESTRUCTIVE_WORDS.test(nearby)) {
    return { dangerous: true, reason: 'nearby text or typed content looks destructive or externally committing' };
  }
  if (SENSITIVE_APPS.test(context.frontmostApp ?? '')) {
    return { dangerous: true, reason: 'frontmost app appears to be messaging, finance, trading, or payment related' };
  }
  return { dangerous: false };
}
