/**
 * Repeat-guard predicates (pure, unit-tested).
 *
 * Two independent layers stop genuine tool loops WITHOUT blocking legitimate
 * multi-file software work (read → edit → test, repeated across many files):
 *
 *  1. The repeat-SEQUENCE guard trips when a tool BATCH repeats within a turn.
 *     Its signature is ARGUMENT-AWARE ({@link buildSequenceSignature}): two
 *     batches collide only when they call the same tools, in the same order,
 *     with the SAME arguments — i.e. the model literally re-issued an identical
 *     batch and will get an identical result. A `read_file → edit_file →
 *     run_command` sweep over DIFFERENT files yields a different signature each
 *     iteration, so methodical multi-file work never trips it. (The old
 *     name-only signature wrongly read 10 reads of 10 different files as one
 *     "stalled pattern" — the false positive this fixes.)
 *  2. {@link isSequenceGuardExempt} additionally SKIPS the guard for a batch made
 *     entirely of mutation tools — an explicit escape hatch surfaced via the
 *     `repeatSequenceExemptTools` knob.
 *
 * The identical-(name,args) per-call loop guard + the storm breaker still catch
 * the real pathology (the same file written with the same content over and over,
 * or the same failing command) independently of this layer.
 */

/** Tools where repeating with DIFFERENT args is normal forward progress. */
export const DEFAULT_SEQUENCE_GUARD_EXEMPT: readonly string[] = ['write_file', 'edit_file', 'apply_patch'];

/**
 * True iff EVERY tool in the repeated sequence is exempt — meaning the sequence
 * guard should be SKIPPED for it (repeating these with varied args is work, and
 * the identical-args guard still protects against true loops).
 */
export function isSequenceGuardExempt(names: string[], exempt: ReadonlySet<string>): boolean {
  if (names.length === 0) return false;
  return names.every((n) => exempt.has(n));
}

/**
 * Order-independent stable JSON so an argument object's key ORDERING never
 * causes two otherwise-identical calls to look different (a false miss).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Normalize one tool call's arguments into a stable digest. Accepts the raw
 * OpenAI argument STRING (parsed then stabilized), an already-parsed object, or
 * undefined; falls back to the trimmed raw text when it isn't valid JSON. Never
 * throws.
 */
export function argsDigest(rawArgs: unknown): string {
  if (typeof rawArgs !== 'string') return rawArgs === undefined ? '' : stableStringify(rawArgs);
  const trimmed = rawArgs.trim();
  if (!trimmed) return '';
  try {
    return stableStringify(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

/**
 * Build the repeat-SEQUENCE signature for a turn's tool batch, keyed on tool
 * NAME *and* a stable digest of ARGS. Two batches collide only when the model
 * re-issued the identical batch (same tools, same order, same arguments) — the
 * only case that is genuinely a no-progress loop. This is what lets a
 * read/edit/apply/test sweep over different files run freely.
 */
export function buildSequenceSignature(calls: ReadonlyArray<{ name: string; args: unknown }>): string {
  return JSON.stringify(calls.map((c) => `${c.name}::${argsDigest(c.args)}`));
}
