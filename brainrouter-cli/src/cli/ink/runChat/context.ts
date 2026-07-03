import type { Agent } from '@kinqs/brainrouter-core/agent';
import type { Config } from '@kinqs/brainrouter-core/config';
import { InputQueue } from '../../../runtime/input/inputQueue.js';
import type { ChatController } from '../ChatApp.js';
import type { createReadlineShim } from './readlineShim.js';

type ReadlineShim = ReturnType<typeof createReadlineShim>;

/**
 * Shared, mutable state + wiring for a single `runChat` mount. Every
 * extracted `runChat/*` helper receives this context so the closure state
 * that used to live inside `runChat` (turn flags, timers, the controller,
 * the shim, the cross-referencing helper functions) stays a single
 * coherent owner of the turn lifecycle — exactly as before, just spread
 * across cohesive modules instead of one 1400-line function body.
 *
 * Primitive turn flags are public mutable fields (read + written from
 * many helpers, identical to the original closure variables). Helper
 * functions are assigned onto the context after construction so the
 * cyclic references between them (footer ↔ child-tracking ↔ turn runner)
 * resolve without an import cycle.
 */
export interface RunChatContext {
  // --- immutable inputs ---
  readonly agent: Agent;
  readonly mcpClient: import('@kinqs/brainrouter-core/mcp').McpClientPool;
  readonly config: Config;
  readonly shim: ReadlineShim;
  readonly inputQueue: InputQueue;
  readonly notifiedCompletions: Set<string>;
  readonly detectGitHubPR: (cwd: string) => string | null;

  // --- mutable turn/session flags (were closure `let`s) ---
  isProcessing: boolean;
  pendingContinuation: boolean;
  goalNoToolStrikes: number;
  idleHintFired: boolean;
  idleHintTimer: NodeJS.Timeout | undefined;
  controller: ChatController | undefined;
  exited: boolean;
  questionCallback: ((line: string) => void) | undefined;
  lastRenderedBanner: string;

  // --- timers (were closure `let`s) ---
  childResumeTimer: ReturnType<typeof setInterval> | null;
  childRefreshTimer: ReturnType<typeof setInterval> | null;
  lastChildCount: number;
  refreshTickN: number;
  scheduleTicker: import('../../../runtime/background/scheduleTicker.js').ScheduleTickerHandle | null;

  // --- helper functions (assigned after construction) ---
  isQuiet: () => boolean;
  armIdleHint: () => void;
  clearIdleHint: () => void;
  refreshFooter: () => void;
  refreshTerminalTitle: () => void;
  getRunningChildCount: () => number;
  getRunningWorkerCount: () => number;
  getRunningWorkflowCount: () => number;
  refreshBackgroundTasks: () => void;
  collectTerminalCompletions: () => import('../../../runtime/background/completionNotices.js').CompletionItem[];
  notifyIdleCompletions: () => void;
  cancelChildResume: () => boolean;
  scheduleGoalContinuation: (afterPrompt: string, afterAnswer: string) => void;
  scheduleChildResume: () => void;
  maybeResumeOnChildComplete: () => void;
  handleQueueCommand: (args: string[]) => void;
  drainInputQueue: () => void;
  runChatTurn: (rawInput: string) => Promise<void>;
  hasLiveActors: () => boolean;
  tickChildRefresh: () => void;
  ensureChildRefreshTimer: () => void;
  startTicker: () => void;
  dispatchSlash: (command: string, args: string[], rl: any) => Promise<void>;
}
