import type { EffortLevel } from '../session/preferencesStore.js';

export type TurnClassification = 'NEW_USER_ASK' | 'MECHANICAL_CONTINUATION' | 'ERROR_CONTINUATION';

interface HistoryMessage {
  role?: unknown;
  content?: unknown;
  isError?: unknown;
  tool_calls?: unknown;
}

export function classifyTurn(history: HistoryMessage[]): TurnClassification {
  let sawToolResult = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index] ?? {};
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      sawToolResult = true;
      if (message.isError === true) return 'ERROR_CONTINUATION';
      continue;
    }
    if (message.role === 'assistant' && sawToolResult && Array.isArray(message.tool_calls)) continue;
    if (message.role === 'user') return sawToolResult ? 'MECHANICAL_CONTINUATION' : 'NEW_USER_ASK';
    return 'NEW_USER_ASK';
  }
  return sawToolResult ? 'MECHANICAL_CONTINUATION' : 'NEW_USER_ASK';
}

export function resolveEffortForTurn(
  effort: EffortLevel | undefined,
  history: HistoryMessage[],
  knobs: { effortRoutingMode: 'adaptive' | 'off'; effortForToolResumeTurns: 'low' | 'medium' },
): EffortLevel | undefined {
  if (knobs.effortRoutingMode !== 'adaptive') return effort;
  if (classifyTurn(history) !== 'MECHANICAL_CONTINUATION') return effort;
  if (effort !== 'high' && effort !== 'xhigh' && effort !== 'max' && effort !== 'ultracode') return effort;
  return knobs.effortForToolResumeTurns;
}
