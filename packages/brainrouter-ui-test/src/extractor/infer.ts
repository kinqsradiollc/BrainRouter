/**
 * Pure control-type + default-action inference from a `data-testid` site. This is
 * the only branching the extractor does, so it is exhaustively unit-tested. Rules
 * are applied most-specific first: an explicit ARIA `role`, then the JSX tag, then
 * a generic `onClick`/`onPress` fallback, then "just an element".
 */
import type { ElementType, ElementAction } from '../types.js';

export interface InferInput {
  /** The owning JSX tag, e.g. `button`, `Input`, `motion.button`. */
  jsxTag: string;
  /** Element carries an onClick / onPress handler. */
  hasOnClick: boolean;
  /** ARIA role attribute value, if any. */
  role?: string;
  /** Element carries an href / to (navigational link). */
  hasHref: boolean;
}

export interface InferResult {
  type: ElementType;
  action: ElementAction;
}

/** Last `.`-segment of a tag, lowercased — so `motion.button` → `button`. */
function baseTag(tag: string): string {
  const lower = tag.toLowerCase();
  const seg = lower.split('.').pop();
  return seg && seg.length ? seg : lower;
}

export function inferTypeAndAction(input: InferInput): InferResult {
  const lower = input.jsxTag.toLowerCase();
  const base = baseTag(input.jsxTag);
  const role = input.role?.toLowerCase();

  // 1 — explicit ARIA role wins.
  if (role === 'button') return { type: 'button', action: 'tap' };
  if (role === 'textbox' || role === 'searchbox') return { type: 'input', action: 'type' };
  if (role === 'link') return { type: 'link', action: input.hasHref ? 'navigate' : 'tap' };
  if (role === 'combobox' || role === 'listbox') return { type: 'select', action: 'tap' };

  // 2 — the JSX tag.
  if (base === 'button' || /button/.test(lower)) return { type: 'button', action: 'tap' };
  if (base === 'input' || base === 'textarea' || /textfield|textinput|textbox|^input/.test(lower)) {
    return { type: 'input', action: 'type' };
  }
  if (base === 'a' || /^link$|navlink|anchor/.test(lower)) {
    return { type: 'link', action: input.hasHref ? 'navigate' : 'tap' };
  }
  if (base === 'select' || /select|dropdown|combobox/.test(lower)) return { type: 'select', action: 'tap' };

  // 3 — anything clickable is a button by behaviour.
  if (input.hasOnClick) return { type: 'button', action: 'tap' };

  // 4 — default: a presence-only element.
  return { type: 'element', action: 'assertVisible' };
}
