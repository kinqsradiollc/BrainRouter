/**
 * ADR-029 F2 — the formula parser, written for text that ARRIVES FROM SYNC.
 *
 * A formula is not typed only by the person looking at it. It lives in a
 * database's schema, and a schema travels between devices and between people who
 * share a database — so this parses untrusted input, and the security rules that
 * apply to any other parser of untrusted text apply here:
 *
 *  - **Not `eval`, and not `new Function`.** A stored string compiled into
 *    executable code is arbitrary code execution against content that syncs
 *    between devices; there is no sandbox argument that survives the fact that
 *    the string arrived over the network. The output of this file is a plain
 *    data tree that `evaluate.ts` walks.
 *  - **Linear time, by construction.** The scanner advances one character at a
 *    time and never backtracks, and there is not a single regular expression in
 *    it. This repository closed a polynomial-ReDoS alert; the way not to reopen
 *    it is to have nothing that can backtrack rather than to write a regex
 *    carefully.
 *  - **Bounded three ways** — length, token count and nesting depth — because
 *    each one bounds a different attack. Length alone permits `((((…` a thousand
 *    deep; a depth limit alone permits a megabyte of digits.
 *
 * Every failure is a typed error VALUE (`value.ts`), never a throw. A formula
 * somebody mistyped on a phone must render as a sentence in the cell, not as a
 * crash in whatever surface happened to open the page.
 */
import {
  err, MAX_FORMULA_LENGTH, type FormulaError,
} from './value.js';

/** A formula with more tokens than this is not one somebody typed. */
export const MAX_FORMULA_TOKENS = 512;
/** Nesting past this is a corrupt or hostile formula, not a hard sum. */
export const MAX_FORMULA_DEPTH = 24;

export type FormulaNode =
  | { t: 'number'; value: number }
  | { t: 'text'; value: string }
  | { t: 'boolean'; value: boolean }
  /** A reference to another property of the SAME row. */
  | { t: 'property'; name: string }
  | { t: 'call'; name: string; args: FormulaNode[] }
  | { t: 'unary'; op: '-' | 'not'; arg: FormulaNode }
  | { t: 'binary'; op: BinaryOp; left: FormulaNode; right: FormulaNode };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'and' | 'or';

export type ParseResult =
  | { ok: true; node: FormulaNode }
  | { ok: false; error: FormulaError };

/* ------------------------------------------------------------------- lexer */

type TokenKind = 'number' | 'text' | 'name' | 'op' | 'end';
interface Token { kind: TokenKind; text: string; at: number }

const SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch);
}

/**
 * Two-character operators are tried before one-character ones.
 *
 * Order is the whole correctness of this: matching `<` first would read `<=` as
 * "less than" followed by an assignment nobody wrote, and the formula would
 * evaluate — differently from what is on screen, which is the worst outcome
 * available.
 */
const OPS_2 = ['!=', '==', '<=', '>=', '&&', '||'];
const OPS_1 = ['=', '<', '>', '+', '-', '*', '/', '%', '^', '(', ')', ','];

function tokenise(source: string): Token[] | FormulaError {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;
    if (SPACE.has(ch)) { i += 1; continue; }

    if (tokens.length >= MAX_FORMULA_TOKENS) {
      return err('too_long', `A formula holds at most ${MAX_FORMULA_TOKENS} terms.`);
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      const start = i;
      while (i < source.length && isDigit(source[i]!)) i += 1;
      if (source[i] === '.') {
        i += 1;
        while (i < source.length && isDigit(source[i]!)) i += 1;
      }
      tokens.push({ kind: 'number', text: source.slice(start, i), at: start });
      continue;
    }

    if (ch === '"' || ch === '\'') {
      const start = i;
      i += 1;
      let out = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!;
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        if (c === ch) { i += 1; closed = true; break; }
        out += c;
        i += 1;
      }
      if (!closed) {
        return err('syntax', 'There is a piece of text in this formula with no closing quote.');
      }
      tokens.push({ kind: 'text', text: out, at: start });
      continue;
    }

    if (isNameStart(ch)) {
      const start = i;
      while (i < source.length && isNameChar(source[i]!)) i += 1;
      tokens.push({ kind: 'name', text: source.slice(start, i), at: start });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (OPS_2.includes(two)) {
      tokens.push({ kind: 'op', text: two, at: i });
      i += 2;
      continue;
    }
    if (OPS_1.includes(ch)) {
      tokens.push({ kind: 'op', text: ch, at: i });
      i += 1;
      continue;
    }

    return err('syntax', `This formula has a “${ch}” in it, which is not something a formula can contain.`);
  }

  tokens.push({ kind: 'end', text: '', at: source.length });
  return tokens;
}

/* ------------------------------------------------------------------ parser */

/** Binding power per operator. Higher binds tighter. */
const PRECEDENCE: Readonly<Record<string, number>> = {
  or: 1, '||': 1,
  and: 2, '&&': 2,
  '=': 3, '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
  '^': 6,
};

function canonicalOp(text: string): BinaryOp {
  if (text === '||') return 'or';
  if (text === '&&') return 'and';
  if (text === '==') return '=';
  return text as BinaryOp;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: 'end', text: '', at: 0 };
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'end') this.index += 1;
    return token;
  }

  /**
   * Precedence climbing, with the depth carried explicitly.
   *
   * The depth is a PARAMETER rather than a field because it has to unwind on the
   * way back out; a counter incremented on entry and forgotten on exit turns a
   * wide formula (`a+b+c+…`) into a "too deep" refusal, which is a bound on the
   * wrong thing and would refuse a formula somebody legitimately wrote.
   */
  parseExpression(minPower: number, depth: number): FormulaNode | FormulaError {
    if (depth > MAX_FORMULA_DEPTH) {
      return err('too_deep', `A formula nests at most ${MAX_FORMULA_DEPTH} levels deep.`);
    }

    let left = this.parseUnary(depth);
    if ('kind' in left) return left;

    for (;;) {
      const token = this.peek();
      const opText = token.kind === 'op' ? token.text
        : token.kind === 'name' && (token.text === 'and' || token.text === 'or') ? token.text
        : null;
      if (!opText) break;
      const power = PRECEDENCE[opText];
      if (power === undefined || power < minPower) break;
      this.next();

      // `^` is right-associative so `2^3^2` is 512, which is what the notation
      // means everywhere else it appears. Everything else is left-associative,
      // so `10-3-2` is 5 rather than 9.
      const nextPower = opText === '^' ? power : power + 1;
      const right = this.parseExpression(nextPower, depth + 1);
      if ('kind' in right) return right;
      left = { t: 'binary', op: canonicalOp(opText), left, right };
    }

    return left;
  }

  private parseUnary(depth: number): FormulaNode | FormulaError {
    const token = this.peek();
    if (token.kind === 'op' && token.text === '-') {
      this.next();
      const arg = this.parseUnary(depth + 1);
      return 'kind' in arg ? arg : { t: 'unary', op: '-', arg };
    }
    if (token.kind === 'name' && token.text === 'not') {
      this.next();
      const arg = this.parseUnary(depth + 1);
      return 'kind' in arg ? arg : { t: 'unary', op: 'not', arg };
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): FormulaNode | FormulaError {
    if (depth > MAX_FORMULA_DEPTH) {
      return err('too_deep', `A formula nests at most ${MAX_FORMULA_DEPTH} levels deep.`);
    }
    const token = this.next();

    if (token.kind === 'number') {
      const value = Number(token.text);
      return Number.isFinite(value)
        ? { t: 'number', value }
        : err('syntax', `“${token.text}” is not a number this formula can use.`);
    }

    if (token.kind === 'text') return { t: 'text', value: token.text };

    if (token.kind === 'op' && token.text === '(') {
      const inner = this.parseExpression(0, depth + 1);
      if ('kind' in inner) return inner;
      const close = this.next();
      if (close.kind !== 'op' || close.text !== ')') {
        return err('syntax', 'There is an opening bracket in this formula with no closing one.');
      }
      return inner;
    }

    if (token.kind === 'name') {
      if (token.text === 'true') return { t: 'boolean', value: true };
      if (token.text === 'false') return { t: 'boolean', value: false };

      const after = this.peek();
      if (after.kind === 'op' && after.text === '(') return this.parseCall(token.text, depth);

      // A bare word is a PROPERTY, so `Cost * Quantity` works without ceremony.
      // `prop("…")` stays available and is the only way to name a column whose
      // name has a space in it — which is why both spellings exist rather than
      // one being a convenience nobody needs.
      return { t: 'property', name: token.text };
    }

    if (token.kind === 'end') {
      return err('syntax', 'This formula stops before it says anything.');
    }
    return err('syntax', `This formula has a “${token.text}” where a value should be.`);
  }

  private parseCall(name: string, depth: number): FormulaNode | FormulaError {
    this.next(); // the '('
    const args: FormulaNode[] = [];

    if (!(this.peek().kind === 'op' && this.peek().text === ')')) {
      for (;;) {
        const arg = this.parseExpression(0, depth + 1);
        if ('kind' in arg) return arg;
        args.push(arg);
        const separator = this.peek();
        if (separator.kind === 'op' && separator.text === ',') { this.next(); continue; }
        break;
      }
    }

    const close = this.next();
    if (close.kind !== 'op' || close.text !== ')') {
      return err('syntax', `The call to ${name}( in this formula has no closing bracket.`);
    }

    // `prop("Name")` is resolved at PARSE time, so the evaluator never sees a
    // property reference whose name is itself computed. A name that could change
    // per row would make the dependency graph a function of the data, and cycle
    // detection would have to run per row against edges nobody can see.
    if (name === 'prop') {
      const first = args[0];
      if (args.length !== 1 || !first || first.t !== 'text') {
        return err('syntax', 'prop() takes the name of one property, in quotes — prop("Cost").');
      }
      return { t: 'property', name: first.value };
    }

    return { t: 'call', name, args };
  }

  atEnd(): boolean {
    return this.peek().kind === 'end';
  }

  rest(): Token {
    return this.peek();
  }
}

/**
 * Parse a formula's source into a tree, or say what is wrong with it.
 *
 * Bounded FIRST, before a single character is scanned: a 100k string is refused
 * by a length comparison rather than by a tokeniser that has to walk it. That is
 * the difference between a bound and a hope.
 */
export function parseFormula(source: string): ParseResult {
  const raw = typeof source === 'string' ? source : '';
  if (raw.length > MAX_FORMULA_LENGTH) {
    return {
      ok: false,
      error: err('too_long', `A formula holds at most ${MAX_FORMULA_LENGTH} characters.`),
    };
  }
  if (raw.trim().length === 0) {
    return { ok: false, error: err('syntax', 'This column has no formula in it yet.') };
  }

  const tokens = tokenise(raw);
  if (!Array.isArray(tokens)) return { ok: false, error: tokens };

  const parser = new Parser(tokens);
  const node = parser.parseExpression(0, 0);
  if ('kind' in node) return { ok: false, error: node };
  if (!parser.atEnd()) {
    const extra = parser.rest();
    return {
      ok: false,
      error: err('syntax', `This formula has a “${extra.text}” after it has already finished.`),
    };
  }
  return { ok: true, node };
}

/**
 * Every property this formula reads, in the order it first mentions them.
 *
 * The dependency graph is built from the SOURCE rather than discovered while
 * evaluating, so a cycle is named before any arithmetic happens — F2's "detected
 * and named, not iterated to a fixed point" is only true if the edges exist
 * independently of the values.
 */
export function formulaDependencies(node: FormulaNode): string[] {
  const found: string[] = [];
  const walk = (current: FormulaNode, depth: number): void => {
    if (depth > MAX_FORMULA_DEPTH * 2) return;
    switch (current.t) {
      case 'property':
        if (!found.includes(current.name)) found.push(current.name);
        return;
      case 'call':
        for (const arg of current.args) walk(arg, depth + 1);
        return;
      case 'unary':
        walk(current.arg, depth + 1);
        return;
      case 'binary':
        walk(current.left, depth + 1);
        walk(current.right, depth + 1);
        return;
      default:
        return;
    }
  };
  walk(node, 0);
  return found;
}
