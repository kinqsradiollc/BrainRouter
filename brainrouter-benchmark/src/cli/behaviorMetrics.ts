/**
 * CC-P8.1 — agent-behavior metrics (0.4.15 thread L).
 *
 * Pure functions that score a CLI session transcript (`transcript.jsonl`
 * entries) on the behavioral contracts the 0.4.15 program enforces. The same
 * numbers gate behavior PRs: baseline first, every CC-P6/P7 change ships its
 * delta. No IO here — the runner feeds parsed entries; fixtures feed tests.
 *
 * Metric definitions (all rates in [0,1], null when the denominator is 0):
 *  - batchingRate        — assistant messages carrying ≥2 tool calls / all
 *                          assistant messages carrying ≥1 tool call. Proxy for
 *                          "independent calls go out in one message".
 *  - prematureQuestionRate — final assistant messages that end on a question
 *                          or an offer ("let me know…", "would you like…")
 *                          instead of a deliverable.
 *  - deliverablePromiseRate — final assistant messages that promise future
 *                          work ("I'll …", "next I will …") — the deliverable
 *                          guard target. Lower is better.
 *  - verificationRate    — sessions whose last workspace mutation is followed
 *                          by a verification command (test/build/typecheck)
 *                          before the final message / sessions with ≥1 mutation.
 *  - editFailureRate     — failed edit-tool results / edit-tool calls.
 *  - toolErrorRate       — failed tool results / all tool results.
 */

export interface BehaviorTranscriptEntry {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  isError?: boolean;
  timestamp?: string;
}

export interface BehaviorMetrics {
  sessions: number;
  assistantToolMessages: number;
  batchingRate: number | null;
  prematureQuestionRate: number | null;
  deliverablePromiseRate: number | null;
  verificationRate: number | null;
  editFailureRate: number | null;
  toolErrorRate: number | null;
  toolCalls: number;
}

const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch']);
const MUTATING_TOOLS = new Set([...EDIT_TOOLS, 'run_command']);
const VERIFY_COMMAND = /\b(npm (run )?test|npm run build|vitest|tsc\b|node --test|pytest|cargo (test|build)|go test|jest)\b/i;

const OFFER_PHRASES = [
  /let me know\b/i,
  /would you like\b/i,
  /do you want me to\b/i,
  /shall i\b/i,
  /want me to\b/i,
];
const PROMISE_PHRASES = [
  /\bi['’]ll (now |then )?\w+/i,
  /\bi will (now |then )?\w+/i,
  /\bnext,? i (will|am going to)\b/i,
  /\bgoing to \w+ (now|next)\b/i,
];

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function toolCallList(entry: BehaviorTranscriptEntry): Array<{ name?: string; arguments?: string }> {
  if (!Array.isArray(entry.tool_calls)) return [];
  return (entry.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>).map((c) => ({
    name: c?.function?.name,
    arguments: c?.function?.arguments,
  }));
}

function isVerificationCall(call: { name?: string; arguments?: string }): boolean {
  if (!call.name) return false;
  if (call.name === 'run_command') return VERIFY_COMMAND.test(call.arguments ?? '');
  return /test|verify/i.test(call.name);
}

/** Index of an entry's final assistant message (no tool_calls = turn ender). */
function finalAssistantText(entries: BehaviorTranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.role === 'assistant' && toolCallList(e).length === 0) {
      const t = textOf(e.content).trim();
      if (t) return t;
    }
  }
  return null;
}

export interface SessionScore {
  toolMessages: number;
  batchedToolMessages: number;
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  editCalls: number;
  editErrors: number;
  hadMutation: boolean;
  verifiedAfterMutation: boolean;
  endsOnQuestionOrOffer: boolean | null; // null when no final assistant text
  endsOnPromise: boolean | null;
}

/** Score one session's transcript. Pure. */
export function scoreSession(entries: BehaviorTranscriptEntry[]): SessionScore {
  let toolMessages = 0;
  let batchedToolMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let toolErrors = 0;
  let editCalls = 0;
  let editErrors = 0;
  let lastMutationIdx = -1;
  let lastVerifyIdx = -1;

  // Map tool_call_id → tool name so error results attribute to edit tools.
  const callNameById = new Map<string, string>();

  entries.forEach((e, idx) => {
    if (e.role === 'assistant') {
      const calls = toolCallList(e);
      if (calls.length > 0) {
        toolMessages += 1;
        if (calls.length >= 2) batchedToolMessages += 1;
        toolCalls += calls.length;
        const raw = Array.isArray(e.tool_calls) ? (e.tool_calls as Array<{ id?: string; function?: { name?: string } }>) : [];
        for (const c of raw) if (c?.id && c.function?.name) callNameById.set(c.id, c.function.name);
        for (const c of calls) {
          if (c.name && EDIT_TOOLS.has(c.name)) editCalls += 1;
          if (c.name && MUTATING_TOOLS.has(c.name)) {
            // run_command counts as a mutation only when it is NOT a verification.
            if (c.name !== 'run_command' || !isVerificationCall(c)) lastMutationIdx = idx;
          }
          if (isVerificationCall(c)) lastVerifyIdx = idx;
        }
      }
    } else if (e.role === 'tool') {
      toolResults += 1;
      if (e.isError) {
        toolErrors += 1;
        const name = e.name ?? (e.tool_call_id ? callNameById.get(e.tool_call_id) : undefined);
        if (name && EDIT_TOOLS.has(name)) editErrors += 1;
      }
    }
  });

  const finalText = finalAssistantText(entries);
  const endsOnQuestionOrOffer = finalText === null
    ? null
    : /\?\s*$/.test(finalText) || OFFER_PHRASES.some((re) => re.test(finalText.slice(-400)));
  const endsOnPromise = finalText === null
    ? null
    : PROMISE_PHRASES.some((re) => re.test(finalText.slice(-400)));

  return {
    toolMessages,
    batchedToolMessages,
    toolCalls,
    toolResults,
    toolErrors,
    editCalls,
    editErrors,
    hadMutation: lastMutationIdx >= 0,
    verifiedAfterMutation: lastMutationIdx >= 0 && lastVerifyIdx > lastMutationIdx,
    endsOnQuestionOrOffer,
    endsOnPromise,
  };
}

/** Aggregate session scores into the headline metrics. Pure. */
export function aggregateBehavior(scores: SessionScore[]): BehaviorMetrics {
  const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
  const toolMessages = scores.reduce((n, s) => n + s.toolMessages, 0);
  const withFinal = scores.filter((s) => s.endsOnQuestionOrOffer !== null);
  const withMutation = scores.filter((s) => s.hadMutation);
  return {
    sessions: scores.length,
    assistantToolMessages: toolMessages,
    batchingRate: ratio(scores.reduce((n, s) => n + s.batchedToolMessages, 0), toolMessages),
    prematureQuestionRate: ratio(withFinal.filter((s) => s.endsOnQuestionOrOffer).length, withFinal.length),
    deliverablePromiseRate: ratio(withFinal.filter((s) => s.endsOnPromise).length, withFinal.length),
    verificationRate: ratio(withMutation.filter((s) => s.verifiedAfterMutation).length, withMutation.length),
    editFailureRate: ratio(scores.reduce((n, s) => n + s.editErrors, 0), scores.reduce((n, s) => n + s.editCalls, 0)),
    toolErrorRate: ratio(scores.reduce((n, s) => n + s.toolErrors, 0), scores.reduce((n, s) => n + s.toolResults, 0)),
    toolCalls: scores.reduce((n, s) => n + s.toolCalls, 0),
  };
}

/** Render the markdown baseline/delta report. Pure. */
export function formatBehaviorReport(m: BehaviorMetrics, opts?: { title?: string }): string {
  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  return [
    `# ${opts?.title ?? 'Agent behavior metrics'}`,
    '',
    `Sessions scored: ${m.sessions} · tool-call messages: ${m.assistantToolMessages} · tool calls: ${m.toolCalls}`,
    '',
    '| Metric | Value | Direction |',
    '|---|---|---|',
    `| Batching rate | ${pct(m.batchingRate)} | higher is better |`,
    `| Premature question/offer rate | ${pct(m.prematureQuestionRate)} | lower is better |`,
    `| Deliverable promise rate | ${pct(m.deliverablePromiseRate)} | lower is better |`,
    `| Verification-after-mutation rate | ${pct(m.verificationRate)} | higher is better |`,
    `| Edit failure rate | ${pct(m.editFailureRate)} | lower is better |`,
    `| Tool error rate | ${pct(m.toolErrorRate)} | lower is better |`,
    '',
  ].join('\n');
}
