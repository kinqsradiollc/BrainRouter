/**
 * Scavenge tool calls leaked into reasoning_content / content
 * (0.3.9 item 11.2).
 *
 * Empirically: some OpenAI-compatible providers (DeepSeek R1,
 * gpt-oss reasoning models, certain LM Studio adapters) emit tool-call
 * JSON inside the `reasoning_content` or `content` channel and forget
 * to populate the standard `tool_calls` field. Without this pass, the
 * call is lost — the next turn re-asks for the same work.
 *
 * Three JSON shapes are accepted (mirroring real-world drift):
 *
 *   1. `{ name, arguments }`            (free-form)
 *   2. `{ type: 'function',             (OpenAI-canonical)
 *        function: { name, arguments } }`
 *   3. `{ tool_name, tool_args }`        (R1 free-form variant)
 */

import { randomUUID } from 'node:crypto';

export interface ScavengedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ScavengeOptions {
  /** Names of tools the model may legitimately call. Unknowns are ignored. */
  allowedNames: ReadonlySet<string>;
  /** Maximum number of calls to scavenge per response (defence against runaway). */
  maxCalls?: number;
}

export interface ScavengeResult {
  calls: ScavengedToolCall[];
  notes: string[];
}

/** Cap the regex input to defeat ReDoS — adversarial input is O(n²). */
const MAX_SCAVENGE_INPUT = 100 * 1024;

export function scavengeToolCalls(
  text: string | null | undefined,
  opts: ScavengeOptions,
): ScavengeResult {
  if (!text) return { calls: [], notes: [] };
  if (text.length > MAX_SCAVENGE_INPUT) {
    return {
      calls: [],
      notes: [`scavenge skipped: input too large (${text.length} chars)`],
    };
  }
  const max = opts.maxCalls ?? 4;
  const notes: string[] = [];
  const out: ScavengedToolCall[] = [];
  for (const candidate of iterateJsonObjects(text)) {
    if (out.length >= max) break;
    const call = coerceToToolCall(candidate, opts.allowedNames);
    if (call) {
      out.push(call);
      notes.push(`scavenged call: ${call.function.name}`);
    }
  }
  return { calls: out, notes };
}

/** Yield every top-level JSON object substring in `text`. */
function* iterateJsonObjects(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (c === '\\') {
          escaped = true;
          continue;
        }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          i = j;
          break;
        }
      }
    }
  }
}

function coerceToToolCall(
  candidateJson: string,
  allowedNames: ReadonlySet<string>,
): ScavengedToolCall | null {
  let parsed: any;
  try {
    parsed = JSON.parse(candidateJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  // Pattern 1: { name, arguments }
  if (typeof parsed.name === 'string' && allowedNames.has(parsed.name)) {
    const args = parsed.arguments;
    return {
      id: `scav_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      type: 'function',
      function: {
        name: parsed.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    };
  }

  // Pattern 2: OpenAI canonical { type: 'function', function: { name, arguments } }
  if (
    parsed.type === 'function' &&
    parsed.function &&
    typeof parsed.function.name === 'string' &&
    allowedNames.has(parsed.function.name)
  ) {
    const args = parsed.function.arguments;
    return {
      id: `scav_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      type: 'function',
      function: {
        name: parsed.function.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    };
  }

  // Pattern 3: { tool_name, tool_args }
  if (typeof parsed.tool_name === 'string' && allowedNames.has(parsed.tool_name)) {
    return {
      id: `scav_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      type: 'function',
      function: {
        name: parsed.tool_name,
        arguments: JSON.stringify(parsed.tool_args ?? {}),
      },
    };
  }

  return null;
}
