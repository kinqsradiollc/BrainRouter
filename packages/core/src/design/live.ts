/**
 * Live variants, the browser-driven half (ADR-056 D-B5).
 *
 * The desktop lets a person pick an element on the running app, name an action
 * and a count; the agent writes N variants INTO THE SOURCE FILE through the
 * `design_variants` tool, the dev server's HMR swaps them in, and the person
 * cycles and accepts one. This module is the deterministic seam both heads
 * share: the bounded brief the agent turn starts from (built from what the
 * browser saw), and the normalisers for the element descriptor the browser
 * returns and for the live-wrapper scan. The wrap / accept / discard file work
 * lives in `variants.ts`; the browser control op and the panel live in the
 * desktop. No model, no filesystem here.
 */

export const LIVE_VARIANT_LIMITS = {
  minCount: 1,
  maxCount: 6,
  selectorChars: 240,
  textChars: 200,
  classes: 12,
  outerHtmlChars: 1_200,
  promptChars: 4_000,
} as const;

/** Where the picked element came from in source, when the framework tells us. */
export interface LiveVariantSourceHint {
  file?: string;
  line?: number;
  framework?: string;
}

/** What the browser reports about the element a person picked. */
export interface LiveVariantTarget {
  /** A short CSS-ish path for display and as a locator of last resort. */
  selector: string;
  tag: string;
  /** Trimmed visible text, bounded. */
  text: string;
  classes: string[];
  elementId?: string;
  /** The element's markup at the moment of the pick, bounded. */
  outerHtml: string;
  hint?: LiveVariantSourceHint;
}

/** One live variants wrapper found on the page. */
export interface LiveVariantScanEntry {
  id: string;
  action: string;
  /** Total children in the wrapper: the original plus the alternatives. */
  count: number;
  /** Which child is showing. */
  active: number;
}

const VARIANT_ID = /^[a-z0-9-]{4,80}$/;

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** `tag.class1.class2#id` — the element named the way a person and the agent both read it. */
export function describeLiveTarget(target: Pick<LiveVariantTarget, 'tag' | 'classes' | 'elementId'>): string {
  return `${target.tag || 'element'}${target.classes.slice(0, 4).map((c) => `.${c}`).join('')}${target.elementId ? `#${target.elementId}` : ''}`;
}

/** Bound and shape a raw descriptor from the page; null when there is no element to speak of. */
export function normalizeLiveTarget(raw: unknown): LiveVariantTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tag = str(r.tag, 40).toLowerCase();
  if (!tag) return null;
  const classes = Array.isArray(r.classes)
    ? r.classes.filter((c): c is string => typeof c === 'string' && !!c.trim()).map((c) => c.trim().slice(0, 40)).slice(0, LIVE_VARIANT_LIMITS.classes)
    : [];
  const hintRaw = r.hint && typeof r.hint === 'object' ? (r.hint as Record<string, unknown>) : null;
  const hint: LiveVariantSourceHint | undefined = hintRaw
    ? {
        ...(typeof hintRaw.file === 'string' && hintRaw.file.trim() ? { file: hintRaw.file.trim().slice(0, 240) } : {}),
        ...(Number.isFinite(Number(hintRaw.line)) && Number(hintRaw.line) > 0 ? { line: Math.trunc(Number(hintRaw.line)) } : {}),
        ...(typeof hintRaw.framework === 'string' && hintRaw.framework.trim() ? { framework: hintRaw.framework.trim().slice(0, 40) } : {}),
      }
    : undefined;
  return {
    selector: str(r.selector, LIVE_VARIANT_LIMITS.selectorChars) || tag,
    tag,
    text: str(r.text, LIVE_VARIANT_LIMITS.textChars),
    classes,
    ...(typeof r.elementId === 'string' && r.elementId.trim() ? { elementId: r.elementId.trim().slice(0, 80) } : {}),
    outerHtml: str(r.outerHtml, LIVE_VARIANT_LIMITS.outerHtmlChars),
    ...(hint && (hint.file || hint.line || hint.framework) ? { hint } : {}),
  };
}

/** Normalise the browser's wrapper scan into a stable, bounded list. */
export function parseLiveScan(raw: unknown): LiveVariantScanEntry[] {
  const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { wrappers?: unknown })?.wrappers) ? (raw as { wrappers: unknown[] }).wrappers : [];
  const out: LiveVariantScanEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    if (!VARIANT_ID.test(id)) continue;
    const count = Math.trunc(Number(r.count));
    if (!Number.isFinite(count) || count < 1) continue;
    const active = Math.min(Math.max(0, Math.trunc(Number(r.active) || 0)), count - 1);
    out.push({ id, action: str(r.action, 40) || 'variant', count, active });
  }
  return out;
}

/** Clamp a requested variant count into the tool's range. */
export function clampVariantCount(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 3;
  return Math.min(LIVE_VARIANT_LIMITS.maxCount, Math.max(LIVE_VARIANT_LIMITS.minCount, n));
}

export interface LiveVariantPromptInput {
  target: LiveVariantTarget;
  action: string;
  count: number;
}

/**
 * The bounded brief a `/design live` turn starts from: what the browser saw,
 * and the one job — locate the element in source and write the variants
 * through `design_variants`, never by hand. The agent does the source-finding;
 * the hint helps where the framework provides one.
 */
export function liveVariantPrompt(input: LiveVariantPromptInput): string {
  const t = input.target;
  const count = clampVariantCount(input.count);
  const action = (input.action || 'variant').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 40) || 'variant';
  const actionPhrase = action === 'variant' ? '' : `${action} `;
  const lines = [
    `Live design variants — the browser-driven half of \`/design\` (ADR-056). The person picked an element on the running app and asked for ${count} ${actionPhrase}variant(s) of it.`,
    `Element: ${describeLiveTarget(t)}${t.text ? ` — text “${t.text}”` : ''}.`,
    t.hint?.file
      ? `Source hint: ${t.hint.file}${t.hint.line ? `:${t.hint.line}` : ''}${t.hint.framework ? ` (${t.hint.framework})` : ''} — start there.`
      : `No source hint from the framework — search the workspace for the distinctive class or the text above.`,
    `Rendered markup (a hint, not the source): ${t.outerHtml || '(none captured)'}`,
    `1. Find this exact element in the workspace source. It is authored markup, not generated output — do not touch build artifacts.`,
    `2. Write ${count} complete ${action} alternative(s) through the tool: design_variants {op:"wrap", file, start, end, variants:[…${count}…], action:"${action}"}, where start/end is the element's character range in that file. Keep each variant the same kind of node the file expects — change the look, not the contract.`,
    `3. Do not edit the file any other way and never write the display:contents wrapper by hand — the tool owns it. HMR swaps the variants into the running page; the person cycles and accepts one in the browser (or with /design accept <id> <n>).`,
    `4. Print the session id the tool returns. If you cannot locate the element with confidence, say so and stop — never wrap the wrong node.`,
  ];
  const prompt = lines.join('\n');
  return prompt.length > LIVE_VARIANT_LIMITS.promptChars ? `${prompt.slice(0, LIVE_VARIANT_LIMITS.promptChars)}\n…` : prompt;
}
