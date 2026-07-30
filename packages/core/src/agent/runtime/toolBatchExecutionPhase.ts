import {
  synthesizeOrphanResults,
  type ToolCallLike,
} from '../guards/toolCallRecovery.js';

export type BatchToolCall = ToolCallLike;

export interface BatchToolMessage {
  role: 'tool';
  tool_call_id: string;
  name: string;
  content: string;
  isError?: boolean;
  [key: string]: unknown;
}

export interface BatchToolResult {
  toolMsg: BatchToolMessage;
  fullResultText: string;
  systemMsg?: unknown;
}

interface ExecuteToolBatchInput {
  toolCalls: BatchToolCall[];
  normalizedNames: string[];
  parallelSafe: boolean[];
  executeOne: (toolCall: BatchToolCall, normalizedName: string) => Promise<BatchToolResult>;
  interrupted: () => boolean;
  onInterrupted: (normalizedName: string, toolCall: BatchToolCall) => void;
}

interface PublishToolBatchInput {
  results: BatchToolResult[];
  publishToolResult: (message: BatchToolMessage, fullResultText: string) => void;
  publishSystemMessage: (message: unknown) => void;
}

interface RepairOrphanToolResultsInput {
  toolCalls: BatchToolCall[];
  results: BatchToolResult[];
  publishSyntheticResult: (message: BatchToolMessage) => void;
}

function failureResult(toolCall: BatchToolCall, name: string, content: string): BatchToolResult {
  return {
    toolMsg: {
      role: 'tool',
      tool_call_id: toolCall.id,
      name,
      content,
      isError: true,
    },
    fullResultText: content,
  };
}

export async function executeToolBatch({
  toolCalls,
  normalizedNames,
  parallelSafe,
  executeOne,
  interrupted,
  onInterrupted,
}: ExecuteToolBatchInput): Promise<BatchToolResult[]> {
  if (
    normalizedNames.length !== toolCalls.length
    || parallelSafe.length !== toolCalls.length
  ) {
    throw new Error('Tool batch metadata must align with the tool-call list.');
  }

  const processed: Array<BatchToolResult | undefined> = new Array(toolCalls.length);

  const runParallelSafeRange = async (start: number, end: number): Promise<void> => {
    const calls = toolCalls.slice(start, end);
    const settled = await Promise.allSettled(
      calls.map((toolCall, offset) => executeOne(toolCall, normalizedNames[start + offset])),
    );

    for (let offset = 0; offset < settled.length; offset += 1) {
      const outcome = settled[offset];
      if (outcome.status === 'fulfilled') {
        processed[start + offset] = outcome.value;
        continue;
      }

      const reason = outcome.reason as { message?: unknown } | undefined;
      const message = typeof reason?.message === 'string'
        ? reason.message
        : String(outcome.reason);
      processed[start + offset] = failureResult(
        calls[offset],
        normalizedNames[start + offset],
        `Tool execution failed: ${message}`,
      );
    }
  };

  let index = 0;
  while (index < toolCalls.length) {
    if (parallelSafe[index]) {
      let end = index + 1;
      while (end < toolCalls.length && parallelSafe[end]) end += 1;
      await runParallelSafeRange(index, end);
      index = end;
    } else {
      processed[index] = await executeOne(toolCalls[index], normalizedNames[index]);
      index += 1;
    }

    if (!interrupted()) continue;

    for (let remaining = index; remaining < toolCalls.length; remaining += 1) {
      if (processed[remaining]) continue;
      const toolCall = toolCalls[remaining];
      const name = normalizedNames[remaining];
      onInterrupted(name, toolCall);
      processed[remaining] = failureResult(
        toolCall,
        name,
        'Skipped: turn interrupted by user.',
      );
    }
    break;
  }

  return processed.map((result, resultIndex) => result ?? failureResult(
    toolCalls[resultIndex],
    normalizedNames[resultIndex],
    'Tool execution failed: scheduler produced no result.',
  ));
}

export function publishToolBatch({
  results,
  publishToolResult,
  publishSystemMessage,
}: PublishToolBatchInput): void {
  const systemMessages: unknown[] = [];
  for (const result of results) {
    publishToolResult(result.toolMsg, result.fullResultText);
    if (result.systemMsg !== undefined) systemMessages.push(result.systemMsg);
  }
  for (const message of systemMessages) publishSystemMessage(message);
}

export function repairOrphanToolResults({
  toolCalls,
  results,
  publishSyntheticResult,
}: RepairOrphanToolResultsInput): void {
  const producedResults = results.map((result) => result.toolMsg);
  for (const synthetic of synthesizeOrphanResults(toolCalls, producedResults)) {
    publishSyntheticResult(synthetic as BatchToolMessage);
  }
}
