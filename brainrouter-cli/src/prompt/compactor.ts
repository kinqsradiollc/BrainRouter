import type { LLMConfig } from '../config/config.js';
import { getCliKnobs } from '../config/config.js';

/**
 * Conversation compaction for long sessions.
 *
 * The REPL's old `/compact` just nuked chat history. That works in a pinch but
 * loses every decision the agent made. This module asks the model to write a
 * structured summary of the conversation so far, then replaces the verbose
 * history with a single condensed system message.
 *
 * The summary lives in a stable shape so the post-compact turn can reason
 * about it without missing critical state:
 *
 *   - Goals: what the user is trying to accomplish
 *   - Decisions: design choices already made
 *   - Files touched: paths the agent has read or written
 *   - Open work: what remains to do
 *   - Last user request: verbatim so the next turn picks up cleanly
 */

// Two-phase compaction prompt adapted from claude-code's
// `services/compact/prompt.ts` (NO_TOOLS_PREAMBLE + <analysis>/<summary>).
// The upfront tool-prohibition prevents adaptive-thinking models (Sonnet 4.6+,
// Gemini 2.5 Pro, recent open-source models with native tool-call slots) from
// "helpfully" calling tools mid-summary — the compaction call passes no
// `tools` array, so any emitted tool_call gets rejected and wastes the only
// turn. The <analysis> block is a scratchpad the model uses to plan the
// summary; the agent loop strips it post-compaction (only <summary> survives).
const COMPACT_SYSTEM_PROMPT = [
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
  '- Do NOT call read_file, run_command, grep_search, write_file, edit_file, memory_*, or ANY other tool.',
  '- Tool calls will be REJECTED and will waste your only turn — you will fail the task.',
  '- Your entire response must be plain text: an <analysis> block followed by a <summary> block.',
  '',
  'You are compacting a long agent conversation so it can continue in a fresh context window. The next turn will see ONLY your <summary> block — everything in the transcript that you do not preserve here is lost.',
  '',
  '## Phase 1 — <analysis>',
  'Open with `<analysis>` and reason through what the conversation actually contains before writing the summary. Note: what the user is really trying to accomplish; which decisions are load-bearing vs incidental; which files / record IDs / error messages MUST survive; which exploratory dead-ends can be discarded. Close with `</analysis>`. This block is stripped after compaction; treat it as a scratchpad.',
  '',
  '## Phase 2 — <summary>',
  'Open with `<summary>` and write the structured summary below. Close with `</summary>`. Use these exact headings in this order — omit a section only if it has nothing to record (do not write "N/A"):',
  '',
  '### Intent',
  'One paragraph: what the user is trying to accomplish across the whole conversation (not just the last turn).',
  '',
  '### Decisions & Assumptions',
  'Bullets. Design choices, scope cuts, and explicit assumptions already agreed upon. Quote file paths where helpful.',
  '',
  '### Files & Symbols',
  'Bullets. File paths the agent has read, written, or edited, with a one-line "why it matters". Include `path:line` anchors for the spots a follow-up turn would need to re-read. Quote BrainRouter record IDs like `[rec_xxx]` inline.',
  '',
  '### Errors & Recoveries',
  'Bullets. Real errors that surfaced + how they were resolved (or the open hypothesis if not resolved). Skip transient retries.',
  '',
  '### Pending Work',
  'Bullets. Concrete next steps with enough context that a fresh agent can act without rereading the transcript. Include any `update_plan` items still `in_progress` or `pending`.',
  '',
  '### Last User Request',
  'Quote the user\'s most recent message verbatim. Do not paraphrase. This anchors the post-compaction turn.',
  '',
  '### Next Step',
  'One sentence: the single most likely first action the post-compaction agent should take. Be specific (tool + target), not "continue working".',
  '',
  'Output Markdown only. No preamble before `<analysis>`. No code fences around the blocks.',
].join('\n');

export interface CompactionInput {
  /** The chat history minus the system message. */
  messages: Array<{ role: string; content: string; name?: string }>;
  /** Workspace root, surfaced in the prompt so the model can be specific. */
  workspaceRoot: string;
  /** The last user message verbatim. */
  lastUserMessage?: string;
}

export interface CompactionResult {
  summary: string;
  /** Approximate token estimate of the produced summary. */
  estimatedTokens: number;
  /** Wall clock for the compaction call (ms). */
  durationMs: number;
}

/**
 * Run compaction by asking the LLM for a structured summary. Returns the
 * summary as a single string; the caller decides how to splice it back into
 * the chat history. We don't mutate state here — that's the agent's job.
 */
export async function runCompaction(llm: LLMConfig, input: CompactionInput): Promise<CompactionResult> {
  const startedAt = Date.now();
  const flattened = input.messages
    .filter((m) => m.role !== 'system')
    .map((m) => `### ${m.role.toUpperCase()}${m.name ? ` (${m.name})` : ''}\n${m.content}`)
    .join('\n\n');

  const userMsg = [
    `# Compaction request`,
    `Workspace: ${input.workspaceRoot}`,
    input.lastUserMessage ? `Last user message (treat as anchor): ${input.lastUserMessage}` : '',
    '',
    '# Conversation transcript',
    flattened,
  ].filter(Boolean).join('\n');

  const body = {
    model: llm.model,
    messages: [
      { role: 'system', content: COMPACT_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
  };

  const endpoint = llm.endpoint || 'https://api.openai.com/v1';
  const apiKey = llm.apiKey || process.env.OPENAI_API_KEY || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const timeoutMs = getCliKnobs().llmTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`compaction call failed: ${res.status} ${res.statusText} - ${errText.slice(0, 500)}`);
  }
  const data = await res.json() as any;
  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('compaction returned an empty summary');

  // Strip the scratchpad <analysis>…</analysis> and unwrap the <summary>
  // envelope. If the model ignored the envelope (older OS models), fall back
  // to the raw text — better a flat summary than a hard failure on resume.
  // Mirrors claude-code's post-process in services/compact/compact.ts.
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  const cleaned = summaryMatch
    ? summaryMatch[1].trim()
    : text.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim();

  return {
    summary: cleaned,
    estimatedTokens: Math.ceil(cleaned.length / 4),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Compose the system block that replaces the verbose chat history after
 * compaction. Keep it tagged so the agent loop knows it came from /compact.
 */
export function renderCompactSystemMessage(summary: string): string {
  return [
    '## Compacted conversation summary',
    '',
    'The conversation up to this point was compacted to fit the context window.',
    'Treat the following as authoritative state and resume from "Last user request".',
    '',
    summary,
  ].join('\n');
}
