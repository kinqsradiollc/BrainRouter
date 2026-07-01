/**
 * RESEARCH LEDGER STORE (§5.2) — session-scoped persistence over the pure
 * evidence-ledger core. One `research.json` per session, so a `/research` turn
 * accumulates evidence across tool calls and emits a brief at the end.
 */

import { getSessionStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';
import {
  createLedger,
  addEntry,
  type ResearchLedger,
  type AddEntryInput,
} from './evidenceLedger.js';

function ledgerFile(workspaceRoot: string, sessionKey: string): string {
  return getSessionStateFile(workspaceRoot, sessionKey, 'research.json');
}

/** The session's ledger, or null when none has been started. */
export function readLedger(workspaceRoot: string, sessionKey: string): ResearchLedger | null {
  return readJsonFile<ResearchLedger | null>(ledgerFile(workspaceRoot, sessionKey), null);
}

/** Start (or re-point) the session's research question, preserving existing entries. */
export function setQuestion(workspaceRoot: string, sessionKey: string, question: string): ResearchLedger {
  const now = new Date().toISOString();
  const current = readLedger(workspaceRoot, sessionKey);
  const ledger = current
    ? { ...current, question: question.trim(), updatedAt: now }
    : createLedger(question, now);
  writeJsonFile(ledgerFile(workspaceRoot, sessionKey), ledger);
  return ledger;
}

/** Append an evidence entry (auto-starting a ledger with an empty question if needed). */
export function appendEvidence(workspaceRoot: string, sessionKey: string, input: AddEntryInput): ResearchLedger {
  const now = new Date().toISOString();
  const current = readLedger(workspaceRoot, sessionKey) ?? createLedger('', now);
  const next = addEntry(current, input, now);
  writeJsonFile(ledgerFile(workspaceRoot, sessionKey), next);
  return next;
}

/** Clear the session's ledger (e.g. starting a fresh research topic). */
export function clearLedger(workspaceRoot: string, sessionKey: string): void {
  writeJsonFile(ledgerFile(workspaceRoot, sessionKey), null);
}
