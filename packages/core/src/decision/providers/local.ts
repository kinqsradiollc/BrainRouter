/**
 * ADR-061 D6 — the `local` provider: our own System One tier, in-process.
 *
 * The tier's shape came from a class of purpose-trained classifiers that answer
 * typed questions in a few hundred milliseconds. We are not calling one. A
 * decision is asked about a shell command, a user's prompt, or a window of tool
 * results — the most sensitive material the loop touches — and shipping that to
 * a third party to be told a number is a trade this product does not need to
 * make. So the tier is ours: a small model already in the registry, asked a
 * question it cannot answer wrongly-shaped.
 *
 * The trick is that the question IS the schema. Every primitive has a closed
 * answer set, so the tool the model must call spells that set out:
 *
 *  - a `noul` is a `number` bounded to [0,1],
 *  - a `choice` is a `string` whose `enum` is exactly the option keys,
 *  - a `score` is a `string` whose `enum` is exactly the ordered levels.
 *
 * That is the port's "cannot be creative" property (D1), moved one step earlier
 * — the model is not asked to be disciplined, it is handed a shape with no room
 * to be otherwise. Anything that gets through anyway still meets
 * `validateAnswer` on the way back, and an answer the question never admitted
 * becomes the rules floor with the reason recorded, never a new outcome.
 *
 * What it does NOT do:
 *
 *  - **It never escalates.** One request, to the declared model, with no
 *    fallback chain behind it (D6). A System One question that fails is the
 *    rule's answer, not a frontier-model call.
 *  - **It never asks for more.** The model is told to answer from what it has
 *    and say it is unsure, because a decision that stalls a tool gate waiting
 *    for context is worse than a decision that admits low confidence.
 *  - **It never sees more than the bound.** The state is truncated here as well
 *    as at the consumer, so a consumer that forgets cannot widen the payload.
 *
 * `confidence` is the model's own report and is worth exactly what D7's
 * calibration eval says it is worth — which is why it is recorded rather than
 * acted on.
 */

import type { LLMConfig } from '../../config/config.js';
import type { DecisionAnswer, DecisionQuestion, DecisionState } from '../types.js';
import type { DecisionProvider } from '../port.js';

/** One classifier answer costs at most this much response body. */
export const LOCAL_DECISION_MAX_RESPONSE_BYTES = 64 * 1024;

/** The one tool the model is allowed to call. */
export const ANSWER_TOOL_NAME = 'answer';

const SYSTEM_PROMPT =
  'You are a fast, precise classifier. You are given a STATE and a set of questions about it. '
  + `Answer every question by calling the \`${ANSWER_TOOL_NAME}\` tool exactly once, and write nothing else. `
  + 'Do not explain your reasoning. Do not ask for more information: answer from what you were '
  + 'given, and say so with a low confidence when the state does not settle it.';

/** What the transport must provide. `callOpenAI`'s shape, narrowed to what is used. */
export type DecisionModelCall = (
  llm: LLMConfig,
  messages: any[],
  tools: any[],
  options: { signal?: AbortSignal; maxResponseBytes?: number; tool_choice?: any },
) => Promise<{ content?: string; toolCalls?: any[] }>;

export interface LocalDecisionProviderOptions {
  /** The declared model. Resolved by the caller; never re-resolved here. */
  llm: LLMConfig;
  /** Hard ceiling on the serialized state, applied again here (D4). */
  maxStateChars?: number;
  /** Injectable transport; defaults to the OpenAI-compatible call. */
  call?: DecisionModelCall;
}

/**
 * The JSON Schema the model must fill. Every question becomes one property
 * whose answer type admits only what the question admits.
 */
export function buildAnswerSchema(questions: Record<string, DecisionQuestion>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    properties[id] = {
      type: 'object',
      description: question.instructions,
      properties: {
        answer: answerSchemaFor(question),
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'How sure you are of this answer, from 0 to 1.',
        },
      },
      required: ['answer'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(questions),
    additionalProperties: false,
  };
}

function answerSchemaFor(question: DecisionQuestion): Record<string, unknown> {
  if (question.kind === 'noul') {
    return {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: `${question.instructions} Answer with the probability that this is true, from 0 to 1.`,
    };
  }
  if (question.kind === 'choice') {
    const criteria = Object.entries(question.options)
      .map(([key, value]) => `"${key}" — ${value}`)
      .join('; ');
    return {
      type: 'string',
      enum: Object.keys(question.options),
      description: `${question.instructions} Pick exactly one: ${criteria}.`,
    };
  }
  return {
    type: 'string',
    enum: [...question.levels],
    description:
      `${question.instructions} Pick exactly one level, lowest to highest: ${question.levels.join(', ')}.`,
  };
}

/** Serialize the state for the prompt, bounded. */
export function serializeState(state: DecisionState, maxChars: number): string {
  const text = typeof state === 'string' ? state : JSON.stringify(state, null, 1);
  const limit = Math.max(40, maxChars);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function createLocalDecisionProvider(options: LocalDecisionProviderOptions): DecisionProvider {
  const maxStateChars = Math.max(40, options.maxStateChars ?? 8_000);
  return {
    name: 'local',
    async answer(state, questions, signal) {
      const call = options.call ?? (await defaultCall());
      const schema = buildAnswerSchema(questions);
      const response = await call(
        options.llm,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `STATE:\n${serializeState(state, maxStateChars)}` },
        ],
        // The transport's INTERNAL tool shape — it wraps this into the wire
        // format itself. Handing it a pre-wrapped OpenAI spec puts a nameless
        // tool with an empty schema on the wire, which is not a loud failure:
        // the model is simply free to answer anything, and the whole "cannot be
        // creative" property is quietly gone. Pinned by a wire-level test.
        [{
          name: ANSWER_TOOL_NAME,
          description: 'Answer every question about the state.',
          inputSchema: schema,
        }],
        {
          signal,
          maxResponseBytes: LOCAL_DECISION_MAX_RESPONSE_BYTES,
          // Force the call: a classifier that replies in prose has not answered.
          tool_choice: { type: 'function', function: { name: ANSWER_TOOL_NAME } },
        },
      );
      const payload = firstToolArguments(response) ?? parseFirstJsonObject(response?.content ?? '');
      if (!payload) throw new Error('the model returned no structured answer');
      return readAnswers(questions, payload);
    },
  };
}

/**
 * Map the model's payload onto the port's answer shape.
 *
 * Deliberately NOT forgiving about values: a probability outside [0,1] or a key
 * the question never offered is passed through verbatim, so the port rejects it
 * and records WHY. Clamping it here would turn a broken provider into a quiet
 * wrong answer, which is the failure mode this whole tier exists to avoid.
 */
export function readAnswers(
  questions: Record<string, DecisionQuestion>,
  payload: Record<string, unknown>,
): Record<string, Pick<DecisionAnswer, 'kind' | 'value'> & Partial<DecisionAnswer>> {
  const out: Record<string, Pick<DecisionAnswer, 'kind' | 'value'> & Partial<DecisionAnswer>> = {};
  for (const [id, question] of Object.entries(questions)) {
    const entry = payload[id];
    if (entry === undefined || entry === null) continue;
    // Tolerate a model that flattened `{answer, confidence}` to a bare value.
    const record = typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined;
    const value = record ? record.answer : entry;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    const confidence = record?.confidence;
    out[id] = {
      kind: question.kind,
      value,
      ...(typeof confidence === 'number' && Number.isFinite(confidence) ? { confidence } : {}),
    };
  }
  return out;
}

function firstToolArguments(response: any): Record<string, unknown> | undefined {
  const call = Array.isArray(response?.toolCalls) ? response.toolCalls[0] : undefined;
  const args = call?.function?.arguments ?? call?.arguments;
  if (typeof args === 'string') return parseFirstJsonObject(args);
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : undefined;
}

/**
 * The first balanced JSON object in a string, fences and prose tolerated.
 *
 * The fallback for a model that ignored `tool_choice` and answered in content
 * anyway — common enough among small models that failing on it would make the
 * tier unusable on exactly the models it is meant for.
 */
export function parseFirstJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
        } catch { return undefined; }
      }
    }
  }
  return undefined;
}

/** Imported lazily so the decision types stay usable without the transport. */
async function defaultCall(): Promise<DecisionModelCall> {
  const { callOpenAI } = await import('../../agent/transport/llmTransport.js');
  return callOpenAI as unknown as DecisionModelCall;
}
