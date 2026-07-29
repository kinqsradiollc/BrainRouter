import type { PlanItem } from '../../task/taskStore.js';

export function emptyAnswerGuardMessage(toolCallCount: number): string {
  return [
    'Runtime empty-answer guardrail tripped.',
    `You ran ${toolCallCount} tool call(s) this turn, then returned an EMPTY response — no text and no further tool_calls. The user only sees your final prose and tool_calls, so right now they got nothing back.`,
    '',
    'Write your final answer NOW, in THIS response:',
    "- Answer the user's original question using what the tools returned.",
    '- Cite concrete findings (files, line numbers, values) from the tool output.',
    '- If the results were inconclusive, say what you found and what is still unknown.',
    '',
    'Do NOT return empty text again, and do NOT just restate that you ran the tools.',
  ].join('\n');
}

export function stalledPreambleGuardMessage(content: string): string {
  const trimmed = content.trim();
  const preview = trimmed.slice(0, 140);
  return [
    'Runtime preamble guardrail tripped.',
    `Your last assistant message was a preamble ("${preview}${trimmed.length > 140 ? '…' : ''}") but ended with NO tool_calls. The user is still waiting for the actual answer — they cannot see your intent, only your tool_calls and final prose.`,
    '',
    'Do ONE of these now, in THIS response:',
    '1. **Execute the next tool batch you announced** — emit structured tool_calls for the reads/grep/spawn you said you were about to do. The preamble alone does not count.',
    '2. **Write the substantive answer the user originally asked for** — the actual analysis, findings, code references, or conclusions. Not another preamble.',
    '',
    'Do NOT write "I\'ll start by…", "Let me…", or any other preamble again. Either call tools or deliver the answer.',
  ].join('\n');
}

export function promisedToolsGuardMessage(): string {
  return [
    'Runtime promise-then-ask guardrail tripped.',
    'Earlier this turn you said you would run tools (scan / read / search / spawn …) but you ran NONE since, and you are now ending the turn — apparently to ask the user instead of acting.',
    '',
    'Before asking the user anything, ask yourself: **can I discover this with a tool?**',
    '- Missing a path, a directory name, which repos match a label, what a file/config contains? → find it now with `list_dir` / `glob_files` / `grep_search` / `read_file`. Do NOT ask the user for something a tool can reveal.',
    '- Genuinely blocked by external info no tool can provide (a credential, a product decision, an ambiguous intent)? → then ask ONE focused question as your only output, and do NOT also claim you are about to act.',
    '',
    'Do the work you promised: emit the tool_calls now, or deliver the substantive answer. Auto-detect sensible defaults and proceed rather than stalling on a question.',
  ].join('\n');
}

export function fanOutGuardMessage(): string {
  return [
    'Runtime fan-out follow-through guardrail tripped.',
    'A fan-out was recommended for this broad/multi-target task, but you are ending the turn having spawned ZERO child agents — that is a shallow single-thread answer, not the parallel coverage the task wanted.',
    '',
    'Do ONE of these now, in THIS response:',
    '1. **Actually fan out** — emit `spawn_agents` with 3–5 children covering distinct angles/targets (one child per comparison target / subsystem), then `wait_agents` and synthesize. Discover targets yourself (`list_dir`, `glob_files`) — do not ask the user for paths you can find.',
    '2. **Justify skipping** — if the task genuinely does not benefit from parallel children (it is small, or the targets are not separable), say so in one sentence and deliver the complete answer.',
    '',
    'Do NOT just promise "I\'ll inspect in parallel" and stop, and do NOT hand back a thin summary while offering to "go deeper if you want" — deliver the deep result now.',
  ].join('\n');
}

export function planSyncGuardMessage(openItems: PlanItem[]): string {
  const openSummary = openItems
    .map((item) => `  - [${item.status === 'in_progress' ? '⏳' : '☐'}] ${item.step}`)
    .join('\n');
  return [
    'Runtime plan-sync guardrail tripped.',
    `You did work this turn but advanced no plan item, and the plan still has ${openItems.length} open item(s):`,
    openSummary,
    '',
    'Before finishing, make the plan honest about what you ACTUALLY did this turn:',
    '- If you completed any of these, call `update_plan` now to mark them `completed` (keep at most one `in_progress`).',
    '- If an item is genuinely still unfinished, leave it as-is and just say so in your answer.',
    'Then deliver your final answer — the user only sees your tool_calls and final prose, not the plan unless you sync it.',
  ].join('\n');
}

export function childSynthesisGuardMessage(): string {
  return [
    'Runtime child-synthesis guardrail tripped.',
    'A child agent already returned its results to you THIS turn, but your answer defers ("I\'ll summarize later" / "still working") instead of delivering them.',
    'Their output is in the conversation above. Synthesize it into your final answer for the user NOW — do not promise a future summary, and do not spawn or wait on new agents.',
  ].join('\n');
}
