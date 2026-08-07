/**
 * ADR-029 E1 — the line becomes something else as you type it.
 *
 * E1 is explicit that this comes BEFORE new block kinds, because a block kind
 * you can only reach through a dropdown is a block kind nobody uses. `# ` and
 * space is how a person who already uses one of these apps makes a heading, and
 * if that does not work then every other feature is being judged by someone who
 * has already decided the editor is wrong.
 *
 * **It returns a transform; it does not mutate.** The caller applies it through
 * the store, so leases, stamps and the outbox still apply and there is still
 * one write path. It also means the whole rule set is testable without a DOM —
 * which matters because the rules are judgements ("does `--- ` fire when there
 * is text after the caret?") and judgements made inside a keydown handler are
 * judgements the dashboard and the CLI will make differently.
 *
 * **The marker must be the entire text before the caret.** Not a prefix match:
 * `# ` fires only when `# ` is all that has been typed, so writing `C# ` in the
 * middle of a sentence stays a sentence. Getting this wrong is the classic
 * editor bug where a paragraph reformats itself three words in.
 */
import { isTextlessKind, MAX_HEADING_LEVEL, type NoteBlockKind } from './block.js';

export interface InputRuleContext {
  /** The block's current kind — some kinds refuse every rule. */
  kind: NoteBlockKind;
  text: string;
  /** Where the caret sits, which is what "just typed the marker" means. */
  caret: number;
  /**
   * The block's current heading level, when it has one.
   *
   * Without it, `# ` typed inside a level-1 heading looks like a change and
   * silently eats the characters — so a person who wanted a literal `#` at the
   * start of their heading cannot type one.
   */
  level?: number;
}

export interface InputRuleTransform {
  /** Which rule matched, so a caller can undo it or explain it. */
  ruleId: string;
  /** The marker the person typed, for an undo that puts it back. */
  marker: string;
  kind: NoteBlockKind;
  /** The block's text with the marker consumed. */
  text: string;
  /** Where the caret lands afterwards. */
  caret: number;
  level?: number;
  checked?: boolean;
  language?: string;
}

/**
 * Kinds a rule may fire inside.
 *
 * `code` is the important exclusion: `# ` in a code block is a comment, and an
 * editor that turns it into a heading makes the one block whose whole purpose
 * is verbatim text the one block that rewrites what you typed. `page` is
 * excluded because its text is the title (E4), and `embed`/`image`/`bookmark`
 * because their text is an address rather than prose.
 */
const RULES_APPLY_IN = new Set<NoteBlockKind>([
  'paragraph', 'heading', 'bullet', 'numbered', 'todo', 'toggle', 'quote', 'callout',
]);

interface Rule {
  id: string;
  /** Exactly what must precede the caret, or a matcher for the variable ones. */
  match: (before: string) => Omit<InputRuleTransform, 'text' | 'caret' | 'marker' | 'ruleId'> | null;
  /** The marker shown in a keyboard-shortcuts list. */
  hint: string;
  label: string;
  /** Rules that would destroy text after the caret only fire on an empty line. */
  requiresEmptyTail?: boolean;
}

const HEADINGS: Record<string, number> = { '# ': 1, '## ': 2, '### ': 3, '#### ': 4, '##### ': 5, '###### ': 6 };

/**
 * `> ` is spoken for by quote, which is E1's list and not negotiable — so
 * toggle and callout get markers of their own rather than `>>` and `>!`.
 * A doubled `>` is unreachable anyway: the single-`>` rule has already fired
 * and consumed the character by the time the second one is typed.
 */
const TOGGLE_MARKER = '+ ';
const CALLOUT_MARKER = '!! ';

const RULES: readonly Rule[] = [
  {
    id: 'heading',
    label: 'Heading',
    hint: '# / ## / ###',
    match: (before) => {
      const level = HEADINGS[before];
      if (level === undefined || level > MAX_HEADING_LEVEL) return null;
      return { kind: 'heading', level };
    },
  },
  {
    id: 'bullet',
    label: 'Bulleted list',
    hint: '- or *',
    match: (before) => (before === '- ' || before === '* ' ? { kind: 'bullet' } : null),
  },
  {
    id: 'numbered',
    label: 'Numbered list',
    hint: '1.',
    // Any starting number, because a person pasting a list from somewhere else
    // types the number they are looking at. The value is thrown away — the
    // ordinal is computed from tree position and never stored.
    match: (before) => (/^\d{1,9}[.)] $/.test(before) ? { kind: 'numbered' } : null),
  },
  {
    id: 'todo',
    label: 'To-do',
    hint: '[] or [x]',
    match: (before) => {
      if (before === '[] ' || before === '[ ] ') return { kind: 'todo', checked: false };
      if (before === '[x] ' || before === '[X] ') return { kind: 'todo', checked: true };
      return null;
    },
  },
  {
    id: 'toggle',
    label: 'Toggle list',
    hint: '+',
    match: (before) => (before === TOGGLE_MARKER ? { kind: 'toggle' } : null),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: '>',
    match: (before) => (before === '> ' ? { kind: 'quote' } : null),
  },
  {
    id: 'callout',
    label: 'Callout',
    hint: '!!',
    match: (before) => (before === CALLOUT_MARKER ? { kind: 'callout' } : null),
  },
  {
    id: 'code',
    label: 'Code',
    hint: '```',
    // ```` ```ts ```` carries the language through, because the alternative is
    // making someone open a dropdown immediately after typing the fence.
    match: (before) => {
      const fence = /^```([A-Za-z0-9+#._-]{0,24})[ \n]$/.exec(before);
      if (!fence) return null;
      const language = fence[1] ?? '';
      return language ? { kind: 'code', language } : { kind: 'code' };
    },
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: '---',
    requiresEmptyTail: true,
    match: (before) => (before === '--- ' || before === '---\n' ? { kind: 'divider' } : null),
  },
];

/**
 * The markers a shortcuts panel lists. One source, so the panel cannot claim a
 * rule that was renamed.
 */
export const INPUT_RULE_HINTS: readonly { id: string; label: string; hint: string }[] =
  RULES.map((rule) => ({ id: rule.id, label: rule.label, hint: rule.hint }));

/**
 * Has this line just become something else?
 *
 * Returns null far more often than not, and that is the normal outcome — the
 * caller applies a transform when it gets one and does nothing otherwise, so
 * there is no "did a rule fire" state to keep in sync with the text.
 */
export function applyInputRule(context: InputRuleContext): InputRuleTransform | null {
  const { kind, text } = context;
  if (typeof text !== 'string') return null;
  if (!RULES_APPLY_IN.has(kind)) return null;

  const caret = Math.min(Math.max(Math.trunc(context.caret), 0), text.length);
  if (caret === 0) return null;

  const before = text.slice(0, caret);
  const tail = text.slice(caret);

  for (const rule of RULES) {
    const hit = rule.match(before);
    if (!hit) continue;
    // A rule that produces a textless block would silently drop whatever is
    // after the caret. Refusing is better than eating half a sentence, and the
    // person can press it again on an empty line.
    if (rule.requiresEmptyTail && tail.trim().length > 0) continue;
    if (isTextlessKind(hit.kind) && tail.trim().length > 0) continue;
    // Nothing to do when the line is already exactly what the rule makes it —
    // otherwise `# ` inside a level-1 heading strips the characters a person
    // was trying to type literally.
    const sameKind = hit.kind === kind;
    const sameLevel = hit.level === undefined || hit.level === context.level;
    if (sameKind && sameLevel && hit.checked === undefined) continue;

    return {
      ruleId: rule.id,
      marker: before,
      ...hit,
      text: isTextlessKind(hit.kind) ? '' : tail,
      caret: 0,
    };
  }
  return null;
}

/**
 * The reverse: the marker put back, for the Backspace that undoes a rule.
 *
 * A rule that cannot be undone by the keystroke that immediately follows it is
 * a rule that has taken the document away from the person. The caller keeps the
 * transform it just applied and hands it back here.
 */
export function undoInputRule(applied: InputRuleTransform, current: string, previousKind: NoteBlockKind): {
  kind: NoteBlockKind;
  text: string;
  caret: number;
} {
  return {
    kind: previousKind,
    text: applied.marker + current,
    caret: applied.marker.length,
  };
}
