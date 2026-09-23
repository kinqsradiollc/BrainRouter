/**
 * ADR-059 — the turn path: what the runtime did or observed during a turn, in
 * order, for a person to read. Model calls, router fallbacks, guardrail
 * re-prompts, provider-side activity, and why the turn ended. Tool calls travel
 * on their own events (`tool-start`/`tool-end`) and hosts interleave them.
 *
 * ADR-061 D5 adds `decision`: a System One answer the loop acted on, so a
 * person can see WHY a command asked, a model was chosen, or memory was
 * skipped — with the probability that produced it.
 *
 * Pure: no I/O. Emission is one call (`emitTurnStep`) that both records the
 * step on the agent for the end-of-turn transcript record and forwards it to
 * the host through `onTurnStep`.
 */

export type TurnStepType = 'model' | 'provider' | 'guard' | 'decision' | 'end';

export interface TurnStep {
  /** Epoch ms. */
  at: number;
  type: TurnStepType;
  /** One short line a person can read — a route, a guard's name, a reason. */
  label: string;
  /** The runtime's one-line reason or outcome. */
  detail?: string;
  /** Outcome when the step has one (a failed route, a guard that fired). */
  ok?: boolean;
  /** For a bounded guard: which attempt this was. */
  attempt?: { n: number; max: number };
}

export type TurnStepInput = Omit<TurnStep, 'at'> & { at?: number };

/** The transcript record name the path is persisted under. Never replayed to a
 *  model: `loadHistory` keeps only user/assistant/tool roles. */
export const TURN_PATH_TRANSCRIPT_NAME = 'turn-path';

interface TurnPathAgent { turnPathSteps: TurnStep[] }
interface TurnPathCallbacks { onTurnStep?: (step: TurnStep) => void }

/** Record a step on the agent and forward it to the host. */
export function emitTurnStep(agent: TurnPathAgent, callbacks: TurnPathCallbacks, input: TurnStepInput): TurnStep {
  const step: TurnStep = { ...input, at: input.at ?? Date.now() };
  agent.turnPathSteps.push(step);
  callbacks.onTurnStep?.(step);
  return step;
}

/**
 * A guard's status line is already the runtime's own words:
 * `Recovery: promised-tools-then-asked (1/2) — steering to discovery`. Turn it
 * into a step without inventing anything: the name, the attempt, the reason.
 */
export function guardStepFromStatus(status: string): TurnStepInput {
  const m = /^Recovery:\s*([^(—]+?)\s*(?:\((\d+)\/(\d+)\))?\s*(?:—\s*(.*))?$/.exec(status.trim());
  const name = (m?.[1] ?? status).trim().replace(/-/g, ' ');
  const attempt = m?.[2] && m?.[3] ? { n: Number(m[2]), max: Number(m[3]) } : undefined;
  const detail = m?.[4]?.trim() || undefined;
  return { type: 'guard', label: `guard: ${name}`, ...(detail ? { detail } : {}), ...(attempt ? { attempt } : {}), ok: false };
}

/** The one-line detail of a completed model call. */
export function modelStepDetail(
  response: { finishReason?: string; toolCalls?: unknown[]; usage?: { completion_tokens?: number } },
  elapsedMs: number,
): string {
  const parts: string[] = [];
  const calls = response.toolCalls?.length ?? 0;
  parts.push(calls > 0 ? `${calls} tool call${calls === 1 ? '' : 's'}` : `finish: ${response.finishReason ?? 'stop'}`);
  if (typeof response.usage?.completion_tokens === 'number') parts.push(`${response.usage.completion_tokens} tokens out`);
  parts.push(`${(elapsedMs / 1000).toFixed(1)} s`);
  return parts.join(' · ');
}

/** Why the turn ended, in the runtime's words. */
export function turnEndLabel(input: { exitedCleanly: boolean; answered: boolean; loopCount: number; maxLoops: number }): string {
  if (!input.exitedCleanly) return `stopped at the tool-loop limit (${input.loopCount}/${input.maxLoops})`;
  return input.answered ? 'answered' : 'ended without an answer';
}

const TYPE_MARK: Record<TurnStepType, string> = { model: 'model', provider: 'provider', guard: 'guard', decision: 'decision', end: 'end' };

/** The path as plain text — the transcript record's `content`, exports, search. */
export function renderTurnPath(steps: readonly TurnStep[]): string {
  if (steps.length === 0) return '';
  const t0 = steps[0].at;
  return steps.map((s) => {
    const dt = `+${((s.at - t0) / 1000).toFixed(1)}s`;
    const outcome = s.ok === undefined ? '' : s.ok ? ' ✓' : ' ✗';
    const attempt = s.attempt ? ` (${s.attempt.n}/${s.attempt.max})` : '';
    return `${dt} ${TYPE_MARK[s.type]}: ${s.label}${attempt}${s.detail ? ` — ${s.detail}` : ''}${outcome}`;
  }).join('\n');
}
