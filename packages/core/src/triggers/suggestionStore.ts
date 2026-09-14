/**
 * Agent-authored follow-up suggestions (ADR-057) — the `suggest_task` store.
 *
 * When the agent notices an out-of-scope fix or improvement mid-task, it
 * records a suggestion here instead of derailing the turn. The desktop
 * surfaces the open ones as one-click starters (new session, optionally in a
 * worktree), mirroring both the GitHub-scanner starters in
 * `triggers/suggestedTasks.ts` and the coding agent's own task chips.
 * Workspace-scoped — a suggestion from any session in the workspace surfaces
 * together — dismissable, and bounded. Deterministic file I/O; no model.
 */
import crypto from 'node:crypto';
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';

export type AgentSuggestionStatus = 'pending' | 'started' | 'dismissed';

export interface AgentSuggestion {
  id: string;
  /** Short imperative action, shown as the chip title. */
  title: string;
  /** Ready-to-run instruction for a fresh session — paste unchanged. */
  suggestedPrompt: string;
  /** One line: why the agent raised it now. */
  reason?: string;
  /** The agent's hint that the work wants its own branch/worktree. */
  worktree?: boolean;
  createdBySessionKey?: string;
  createdAt: number;
  status: AgentSuggestionStatus;
  /** The session a "start" launched, once it has been acted on. */
  startedSessionKey?: string;
}

interface SuggestionFile { version: 1; suggestions: AgentSuggestion[] }

const EMPTY: SuggestionFile = { version: 1, suggestions: [] };
const FILE_NAME = 'agent-suggestions.json';
const MAX = 50;
const MAX_TITLE = 200;
const MAX_PROMPT = 4_000;
const MAX_REASON = 300;

function filePath(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, FILE_NAME);
}

function bound(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Every stored suggestion, newest first. Never throws. */
export function loadAgentSuggestions(workspaceRoot: string): AgentSuggestion[] {
  const list = readJsonFile<SuggestionFile>(filePath(workspaceRoot), EMPTY).suggestions ?? [];
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/** The open suggestions the desktop shows as starters. */
export function pendingAgentSuggestions(workspaceRoot: string): AgentSuggestion[] {
  return loadAgentSuggestions(workspaceRoot).filter((s) => s.status === 'pending');
}

export interface AgentSuggestionInput {
  title: string;
  suggestedPrompt: string;
  reason?: string;
  worktree?: boolean;
}

/**
 * Record a suggestion and return it. Deduplicates against an existing PENDING
 * suggestion with the same title (the agent re-noticing one thing does not
 * pile up), and caps the store at MAX, dropping the oldest resolved entries
 * first so a pending item is never evicted.
 */
export function addAgentSuggestion(workspaceRoot: string, input: AgentSuggestionInput, sessionKey?: string): AgentSuggestion {
  const title = bound(input.title, MAX_TITLE);
  const suggestedPrompt = bound(input.suggestedPrompt, MAX_PROMPT);
  if (!title || !suggestedPrompt) throw new Error('suggest_task needs a non-empty title and prompt.');
  const list = loadAgentSuggestions(workspaceRoot);
  const dupe = list.find((s) => s.status === 'pending' && s.title.toLowerCase() === title.toLowerCase());
  if (dupe) return dupe;
  const reason = bound(input.reason, MAX_REASON);
  const record: AgentSuggestion = {
    id: crypto.randomUUID(),
    title,
    suggestedPrompt,
    ...(reason ? { reason } : {}),
    ...(input.worktree ? { worktree: true } : {}),
    ...(sessionKey ? { createdBySessionKey: sessionKey } : {}),
    createdAt: Date.now(),
    status: 'pending',
  };
  const next = [record, ...list];
  const trimmed = next.length > MAX
    ? [...next.filter((s) => s.status === 'pending'), ...next.filter((s) => s.status !== 'pending')].slice(0, MAX)
    : next;
  writeJsonFile(filePath(workspaceRoot), { version: 1, suggestions: trimmed } satisfies SuggestionFile);
  return record;
}

/**
 * Flip a suggestion's status — `started` when it launches a session,
 * `dismissed` when the user waves it off. Returns the updated record, or null
 * when the id is unknown.
 */
export function setAgentSuggestionStatus(
  workspaceRoot: string,
  id: string,
  status: AgentSuggestionStatus,
  startedSessionKey?: string,
): AgentSuggestion | null {
  const list = loadAgentSuggestions(workspaceRoot);
  const hit = list.find((s) => s.id === id);
  if (!hit) return null;
  hit.status = status;
  if (status === 'started' && startedSessionKey) hit.startedSessionKey = startedSessionKey;
  writeJsonFile(filePath(workspaceRoot), { version: 1, suggestions: list } satisfies SuggestionFile);
  return hit;
}
