import type { LLMConfig } from '../config/config.js';

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

const COMPACT_SYSTEM_PROMPT = [
  'You are compacting a long agent conversation so it can continue in a fresh context window.',
  'Produce a structured summary the next turn can read in 1 second. Use the headings shown below.',
  '',
  '# Goals',
  'List the user\'s current high-level goals as bullets.',
  '',
  '# Decisions made',
  'List decisions, choices, or assumptions already agreed upon. Quote file paths where helpful.',
  '',
  '# Files touched',
  'List file paths the agent has read, written, or edited.',
  '',
  '# Open work',
  'List what is still pending — bug fixes, follow-ups, tests, reviews.',
  '',
  '# Last user request',
  'Quote the user\'s most recent message verbatim. Do not paraphrase.',
  '',
  'Output Markdown only. No preamble. No code fences around the summary itself.',
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

  const timeoutMs = Number(process.env.BRAINROUTER_LLM_TIMEOUT_MS || 60000);
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
  return {
    summary: text,
    estimatedTokens: Math.ceil(text.length / 4),
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
