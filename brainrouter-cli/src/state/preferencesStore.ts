import { getCliStateFile, readJsonFile, writeJsonFile } from './cliState.js';

/**
 * Per-workspace runtime preferences that don't justify their own file.
 *
 * Persisted at `<workspace>/.brainrouter/cli/preferences.json` so they survive
 * CLI restarts but stay scoped to the project (different repos can have
 * different settings).
 */

export interface Preferences {
  /** When true, every worker spawn is auto-followed by a reviewer pass on the diff. */
  autoReview: boolean;
  /** Editor mode for the readline composer. */
  editorMode: 'emacs' | 'vi';
  /** Status-line layout: comma-separated segments from {mode,branch,dirty,model,tokens,session}. */
  statusline: string;
  /**
   * When true, `run_command` skips the per-call confirmation prompt and runs
   * immediately. Pair with sandboxing (BRAINROUTER_SANDBOX=on) if you want
   * the safety net without the friction. Off by default — opt-in via /yolo.
   */
  autoApproveShell: boolean;
  /** Syntax highlighting theme for markdown output. Tied to/theme. */
  theme: 'auto' | 'light' | 'dark' | 'mono';
  /** Terminal title format segments (model, branch, session, mode) or 'off'. Tied to/title. */
  terminalTitle: string;
  /** Communication style for the agent. Tied to/personality. */
  personality: 'concise' | 'standard' | 'detailed' | 'pair-programmer';
  /** When true, REPL output skips markdown rendering for copy-friendly raw text. Tied to/raw. */
  rawScrollback: boolean;
  /** When true, gated experimental features are unlocked. Tied to/experimental. */
  experimental: boolean;
  /** When true, the memory pipeline runs phase1/phase2 consolidation on session start. Tied to/memories. */
  memoriesEnabled: boolean;
  /** Custom keybindings as JSON-stringified map for /keymap. Empty means defaults. */
  keymap: string;
  /** Extra read-only paths granted to sandboxed run_command. Workspace is always readable+writable. */
  sandboxReadPaths: string[];
  /** Extra write-allowed paths granted to sandboxed run_command. */
  sandboxWritePaths: string[];
  /**
   * When true, hide non-essential chrome from the REPL: briefing/recall
   * tables, tool-completion previews, spawn dumps. Leaves spinner + model
   * prose. Tied to /quiet and the --quiet startup flag. Off by default.
   */
  quiet: boolean;
}

const DEFAULT: Preferences = {
  autoReview: false,
  editorMode: 'emacs',
  statusline: 'mode',
  autoApproveShell: false,
  theme: 'auto',
  terminalTitle: 'model,session',
  personality: 'standard',
  rawScrollback: false,
  experimental: false,
  memoriesEnabled: true,
  keymap: '',
  sandboxReadPaths: [],
  sandboxWritePaths: [],
  quiet: false,
};

export function readPreferences(workspaceRoot: string): Preferences {
  const stored = readJsonFile<Partial<Preferences>>(
    getCliStateFile(workspaceRoot, 'preferences.json'),
    {},
  );
  return { ...DEFAULT, ...stored };
}

export function writePreferences(workspaceRoot: string, prefs: Partial<Preferences>): Preferences {
  const merged = { ...readPreferences(workspaceRoot), ...prefs };
  writeJsonFile(getCliStateFile(workspaceRoot, 'preferences.json'), merged);
  return merged;
}
