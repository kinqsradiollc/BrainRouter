/**
 * MC-B3 — automation rules: per-workspace `on` / `when` / `do` markdown files
 * that map verified trigger events (MC-B1) onto agent actions.
 *
 * Rules reuse the hookify shape the org already knows — a `.md` file whose
 * YAML frontmatter is the condition and whose markdown body is the payload —
 * but live IN the workspace (`<ws>/.brainrouter/automations/*.md`) so teams
 * can commit and review them like CI config:
 *
 *   ---
 *   on: github.issue.labeled
 *   when: "label == 'brainrouter'"
 *   do: build
 *   enabled: true
 *   ---
 *
 *   Extra instructions appended to the job prompt.
 *
 * - `on` matches the neutral event's `<provider>.<kind>` name exactly.
 * - `when` is a SAFE mini-expression over event fields: `==` `!=` `&&` `||`
 *   `!` and parentheses, with dot-path field lookups and quoted string
 *   literals. It is evaluated by the tiny hand-rolled parser below — never
 *   `eval` / `new Function` — and ANY malformed input evaluates to `false`
 *   (fail-closed: a rule with a broken condition can never fire).
 * - `do` picks the action; the body rides along as extra instructions.
 *
 * The registry is the directory itself: list = parse every file,
 * enable/disable = rewrite the `enabled:` frontmatter line in place, so the
 * on-disk file stays the single source of truth.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TriggerEvent } from './triggerTypes.js';

/** Actions a rule can request. `custom` = the body IS the job prompt. */
export type AutomationAction = 'build' | 'fix-ci' | 'review' | 'custom';

export const AUTOMATION_ACTIONS: readonly AutomationAction[] = ['build', 'fix-ci', 'review', 'custom'];

export interface AutomationRule {
  /** Stable identifier: the filename without the `.md` extension. */
  id: string;
  /** Human-readable name from frontmatter (falls back to the id). */
  name: string;
  /** `<provider>.<kind>` event name this rule listens for. */
  on: string;
  /** Raw `when` expression ('' = unconditional). */
  when: string;
  /** The action to take when the rule fires. */
  do: AutomationAction;
  enabled: boolean;
  /** Markdown body — extra prompt/instructions for the spawned job. */
  instructions: string;
  /** Absolute path of the source file (so listings can cite it). */
  sourcePath: string;
}

/** The neutral event shape rules are matched against. */
export interface AutomationEvent {
  /** `<provider>.<kind>`, e.g. `github.issue.labeled`. */
  on: string;
  /** Dot-path-navigable field bag the `when` expression probes. */
  fields: Record<string, unknown>;
}

/** Where a workspace keeps its committed automation rules. */
export function automationsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'automations');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Strip one layer of matching surrounding quotes from a frontmatter value. */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse one rule file's CONTENT. Pure so the shape is trivially testable.
 * Returns null for anything that isn't a well-formed rule — a malformed file
 * silently contributes nothing (fail-closed), it can never half-match.
 */
export function parseAutomationRuleContent(
  content: string,
  id: string,
  sourcePath: string,
): AutomationRule | null {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    meta[line.slice(0, sep).trim()] = unquote(line.slice(sep + 1).trim());
  }
  const on = (meta.on ?? '').trim();
  if (!on) return null;
  // `do` defaults to custom (body = prompt); an EXPLICIT unknown action is a
  // typo we refuse to guess at — the rule is dropped rather than misrouted.
  const action = meta.do === undefined ? 'custom' : (meta.do.trim() as AutomationAction);
  if (!AUTOMATION_ACTIONS.includes(action)) return null;
  return {
    id,
    name: meta.name?.trim() || id,
    on,
    when: (meta.when ?? '').trim(),
    do: action,
    enabled: meta.enabled === undefined ? true : meta.enabled.trim() === 'true',
    instructions: match[2].trim(),
    sourcePath,
  };
}

/** Parse one rule file from disk; null when unreadable or malformed. */
export function parseAutomationRuleFile(filePath: string): AutomationRule | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseAutomationRuleContent(content, path.basename(filePath).replace(/\.md$/, ''), filePath);
  } catch {
    return null;
  }
}

/**
 * Load every rule in a workspace's automations directory, sorted by id.
 * Malformed files are skipped — one broken rule never poisons the registry.
 */
export function loadRules(workspaceRoot: string): AutomationRule[] {
  const dir = automationsDir(workspaceRoot);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: AutomationRule[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const rule = parseAutomationRuleFile(path.join(dir, entry));
    if (rule) out.push(rule);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Registry read surface — alias that says what it is. */
export const listAutomationRules = loadRules;

// ---------------------------------------------------------------------------
// The `when` mini-expression — a tiny hand-rolled evaluator. NO eval, NO
// new Function, NO regex-built code. Grammar (all values are strings):
//
//   or   := and ( '||' and )*
//   and  := unary ( '&&' unary )*
//   unary:= '!' unary | primary
//   primary := '(' or ')' | operand ( ('==' | '!=') operand )?
//   operand := 'literal' | "literal" | field.path
//
// Malformed input at ANY stage (unknown token, unclosed quote/paren,
// trailing tokens, over-long input) evaluates to false.
// ---------------------------------------------------------------------------

/** Hard cap on expression length — nobody needs a novel in `when:`. */
export const WHEN_EXPRESSION_MAX_LENGTH = 2_000;

type WhenToken =
  | { t: 'lparen' | 'rparen' | 'eq' | 'ne' | 'and' | 'or' | 'not' }
  | { t: 'str'; v: string }
  | { t: 'field'; v: string };

const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*/;

function tokenizeWhen(src: string): WhenToken[] | null {
  const out: WhenToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i += 1; continue; }
    if (ch === '(') { out.push({ t: 'lparen' }); i += 1; continue; }
    if (ch === ')') { out.push({ t: 'rparen' }); i += 1; continue; }
    if (src.startsWith('==', i)) { out.push({ t: 'eq' }); i += 2; continue; }
    if (src.startsWith('!=', i)) { out.push({ t: 'ne' }); i += 2; continue; }
    if (src.startsWith('&&', i)) { out.push({ t: 'and' }); i += 2; continue; }
    if (src.startsWith('||', i)) { out.push({ t: 'or' }); i += 2; continue; }
    if (ch === '!') { out.push({ t: 'not' }); i += 1; continue; }
    if (ch === '"' || ch === "'") {
      let value = '';
      let closed = false;
      i += 1;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\' && i + 1 < src.length) { value += src[i + 1]; i += 2; continue; }
        if (c === ch) { closed = true; i += 1; break; }
        value += c;
        i += 1;
      }
      if (!closed) return null; // unterminated literal
      out.push({ t: 'str', v: value });
      continue;
    }
    const m = FIELD_PATH_RE.exec(src.slice(i));
    if (m) { out.push({ t: 'field', v: m[0] }); i += m[0].length; continue; }
    return null; // anything else is not part of the language
  }
  return out;
}

/**
 * Coerce one resolved field value to its comparable string form. Strings
 * pass through; numbers/booleans stringify; objects carrying a string
 * `name` collapse to it (so `label == 'x'` works on GitHub-style
 * `{ label: { name: 'x' } }` payloads); everything else is "missing".
 */
function coerceFieldValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value !== null && typeof value === 'object') {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

function resolveFieldPath(fields: Record<string, unknown>, dotPath: string): string | undefined {
  let current: unknown = fields;
  for (const segment of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return coerceFieldValue(current);
}

class WhenParseError extends Error {}

class WhenParser {
  private pos = 0;

  constructor(
    private readonly tokens: WhenToken[],
    private readonly fields: Record<string, unknown>,
  ) {}

  evaluate(): boolean {
    const result = this.parseOr();
    if (this.pos !== this.tokens.length) throw new WhenParseError('trailing tokens');
    return result;
  }

  private peek(): WhenToken | undefined {
    return this.tokens[this.pos];
  }

  private parseOr(): boolean {
    let value = this.parseAnd();
    while (this.peek()?.t === 'or') {
      this.pos += 1;
      // No short-circuit: the right side is pure and must still parse.
      const rhs = this.parseAnd();
      value = value || rhs;
    }
    return value;
  }

  private parseAnd(): boolean {
    let value = this.parseUnary();
    while (this.peek()?.t === 'and') {
      this.pos += 1;
      const rhs = this.parseUnary();
      value = value && rhs;
    }
    return value;
  }

  private parseUnary(): boolean {
    if (this.peek()?.t === 'not') {
      this.pos += 1;
      return !this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): boolean {
    const token = this.peek();
    if (!token) throw new WhenParseError('unexpected end of expression');
    if (token.t === 'lparen') {
      this.pos += 1;
      const inner = this.parseOr();
      if (this.peek()?.t !== 'rparen') throw new WhenParseError('unbalanced parenthesis');
      this.pos += 1;
      return inner;
    }
    const left = this.parseOperand();
    const op = this.peek();
    if (op && (op.t === 'eq' || op.t === 'ne')) {
      this.pos += 1;
      const right = this.parseOperand();
      const equal = (left ?? '') === (right ?? '');
      return op.t === 'eq' ? equal : !equal;
    }
    // Bare operand → truthiness: present, non-empty, and not literal "false".
    return left !== undefined && left !== '' && left !== 'false';
  }

  private parseOperand(): string | undefined {
    const token = this.peek();
    if (!token) throw new WhenParseError('missing operand');
    if (token.t === 'str') { this.pos += 1; return token.v; }
    if (token.t === 'field') { this.pos += 1; return resolveFieldPath(this.fields, token.v); }
    throw new WhenParseError(`unexpected token ${token.t}`);
  }
}

/**
 * Evaluate a `when` expression against an event field bag. '' means
 * unconditional (true); ANY malformed expression is false — a broken
 * condition must never fire an automation.
 */
export function evaluateWhen(expression: string, fields: Record<string, unknown>): boolean {
  const src = expression.trim();
  if (!src) return true;
  if (src.length > WHEN_EXPRESSION_MAX_LENGTH) return false;
  const tokens = tokenizeWhen(src);
  if (!tokens || tokens.length === 0) return false;
  try {
    return new WhenParser(tokens, fields).evaluate();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Build the field bag rules are evaluated against: the (already bounded +
 * redacted) provider payload keys, overlaid by the neutral envelope fields
 * (`provider` / `kind` / `repo` / `number` / `sender`) which always win.
 */
export function buildAutomationEvent(event: TriggerEvent, payload?: unknown): AutomationEvent {
  const fields: Record<string, unknown> = {};
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    Object.assign(fields, payload as Record<string, unknown>);
  }
  fields.provider = event.provider;
  fields.kind = event.kind;
  fields.repo = event.repo;
  if (event.number !== undefined) fields.number = event.number;
  fields.sender = event.sender;
  return { on: `${event.provider}.${event.kind}`, fields };
}

/**
 * Re-read the persisted (bounded, redacted) payload an event points at.
 * Null on any failure — matching then runs on the envelope fields alone.
 */
export function readTriggerPayload(event: Pick<TriggerEvent, 'payloadRef'>): unknown {
  if (!event.payloadRef) return null;
  try {
    return JSON.parse(fs.readFileSync(event.payloadRef, 'utf8'));
  } catch {
    return null;
  }
}

/** All enabled rules whose `on` names this event and whose `when` holds. */
export function matchRules(rules: AutomationRule[], event: AutomationEvent): AutomationRule[] {
  const on = event.on.trim().toLowerCase();
  return rules.filter(
    (rule) =>
      rule.enabled &&
      rule.on.trim().toLowerCase() === on &&
      evaluateWhen(rule.when, event.fields),
  );
}

// ---------------------------------------------------------------------------
// Registry mutation — enable/disable persists into the source file.
// ---------------------------------------------------------------------------

const RULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Flip a rule's `enabled:` frontmatter line in place. Returns false when the
 * id is unknown (or unsafe) — never throws, never touches the body.
 */
export function setAutomationRuleEnabled(
  workspaceRoot: string,
  id: string,
  enabled: boolean,
): boolean {
  if (!RULE_ID_RE.test(id)) return false;
  const file = path.join(automationsDir(workspaceRoot), `${id}.md`);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return false;
  let frontmatter = match[1];
  if (/^enabled\s*:/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(/^enabled\s*:.*$/m, `enabled: ${enabled}`);
  } else {
    frontmatter = `enabled: ${enabled}\n${frontmatter}`;
  }
  try {
    fs.writeFileSync(file, `---\n${frontmatter}\n---\n${match[2]}`, 'utf8');
  } catch {
    return false;
  }
  return true;
}
