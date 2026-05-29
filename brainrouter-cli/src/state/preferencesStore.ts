import { getCliStateFile, readJsonFile, writeJsonFile } from './cliState.js';
import { getRawCliKnobs } from '../config/config.js';

/**
 * Per-workspace runtime preferences that don't justify their own file.
 *
 * Persisted at `<workspace>/.brainrouter/cli/preferences.json` so they survive
 * CLI restarts but stay scoped to the project (different repos can have
 * different settings).
 */

export type ExecutionMode = 'planning' | 'fast';
export type ReviewPolicy = 'request' | 'proceed';
export type EffortLevel = 'low' | 'medium' | 'high';

export interface Preferences {
  /** When true, every worker spawn is auto-followed by a reviewer pass on the diff. */
  autoReview: boolean;
  /**
   * MAS-P4-T4 auto-chain mode. Canonical successor to `autoReview`:
   * after a worker finishes, chain `review` / `verify` / `both` follow-ups
   * (or `off`). Omitted = derive from `autoReview` for back-compat.
   */
  autoChain?: 'off' | 'review' | 'verify' | 'both';
  /**
   * MAS-P4-T2 supervisor gate. Controls whether/when the agent may spawn
   * child agents: auto | ask-before-spawn | ask-before-write-child |
   * no-children. Omitted = auto.
   */
  delegationPolicy?: 'auto' | 'ask-before-spawn' | 'ask-before-write-child' | 'no-children';
  /** Editor mode for the readline composer. */
  editorMode: 'emacs' | 'vi';
  /** Status-line layout: comma-separated segments from {mode,branch,dirty,model,tokens,session}. */
  statusline: string;
  /**
   * Session execution stance. `planning` (default) routes `run_command`
   * through the per-call `askYesNo` confirmation and keeps the system prompt
   * leaning toward clarify-before-act. `fast` skips the confirmation for
   * non-dangerous commands (see `isDangerousCommand`) and tells the model
   * to jump to implementation. Toggle with `/mode`.
   */
  executionMode: ExecutionMode;
  /**
   * Behaviour at workflow / multi-file approval gates. `request` (default)
   * keeps today's prose-based "ready for your approval?" gesture in front
   * of `/approve`. `proceed` tells the model to apply the plan and report
   * after, without the explicit ask. Toggle with `/review-policy`.
   */
  reviewPolicy: ReviewPolicy;
  /**
   * DEPRECATED — superseded by `executionMode` + `reviewPolicy` in 0.3.6.
   * Kept on disk so older callers keep functioning during the alias
   * transition. New code MUST read `executionMode === 'fast'` instead;
   * `readPreferences` back-fills the new fields from this on first read.
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
  /**
   * Reasoning depth preference. `medium` (default) is today's behaviour and
   * emits no system-prompt overlay and no provider-side reasoning slot.
   * `low` adds a "be terse, skip ceremony" overlay; `high` adds a
   * step-by-step audit overlay. When the LLM endpoint exposes a reasoning
   * slot (gpt-5 / o-series via Chat Completions accept `reasoning_effort`),
   * the level is also forwarded as the provider-native enum. Tied to
   * `/effort` and the `BRAINROUTER_EFFORT` env override.
   */
  effort: EffortLevel;
  /**
   * 0.3.9 item 13 — model-tier pin. `flash | standard | pro` pin the
   * model for the rest of the session through `/tier`. `null` (the
   * default) means "follow the model field as-is; allow self-escalation
   * via the <<<NEEDS_HIGH>>> marker".
   */
  tier?: 'flash' | 'standard' | 'pro' | null;
  /**
   * When true (default), the brain's distilled Core Identity is pinned
   * into the cache-stable briefing prefix on every turn. `false`
   * suppresses persona injection without deleting the underlying
   * `core_identity` row. Tied to `/persona on|off`. Layered with the
   * system-wide `cli.personaAnchor` knob in `config.json`; both must
   * be on for the anchor to fire. Per the 0.3.9 env→config migration,
   * no `BRAINROUTER_*` env var is consulted.
   */
  personaAnchorEnabled: boolean;
}

const DEFAULT: Preferences = {
  autoReview: false,
  editorMode: 'emacs',
  statusline: 'mode',
  executionMode: 'planning',
  reviewPolicy: 'request',
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
  effort: 'medium',
  personaAnchorEnabled: true,
};

/**
 * Back-fill `executionMode` / `reviewPolicy` from the legacy
 * `autoApproveShell` flag when an older prefs file is read for the first
 * time. Migration is read-only and idempotent: if either new field is
 * already present we leave both alone (the user has already opted into the
 * new model and any drift between the two is intentional). The legacy field
 * stays on disk so other readers don't break during the alias period.
 */
function migrateLegacyShell(stored: Partial<Preferences>): Partial<Preferences> {
  const hasNewFields = stored.executionMode !== undefined || stored.reviewPolicy !== undefined;
  if (hasNewFields) return stored;
  if (stored.autoApproveShell !== true) return stored;
  return {
    ...stored,
    executionMode: 'fast',
    reviewPolicy: 'proceed',
  };
}

export function readPreferences(workspaceRoot: string): Preferences {
  const stored = readJsonFile<Partial<Preferences>>(
    getCliStateFile(workspaceRoot, 'preferences.json'),
    {},
  );
  return { ...DEFAULT, ...migrateLegacyShell(stored) };
}

export function writePreferences(workspaceRoot: string, prefs: Partial<Preferences>): Preferences {
  const merged = { ...readPreferences(workspaceRoot), ...prefs };
  writeJsonFile(getCliStateFile(workspaceRoot, 'preferences.json'), merged);
  return merged;
}

/**
 * `/yolo on` shorthand: flip both new fields to their "do not interrupt me"
 * setting. We also keep the legacy `autoApproveShell` mirror in sync so any
 * external tooling that still inspects it sees a consistent state during
 * the alias period.
 */
export function applyYoloOn(workspaceRoot: string): Preferences {
  return writePreferences(workspaceRoot, {
    executionMode: 'fast',
    reviewPolicy: 'proceed',
    autoApproveShell: true,
  });
}

/**
 * `/yolo off` shorthand: restore the conservative defaults on both axes.
 */
export function applyYoloOff(workspaceRoot: string): Preferences {
  return writePreferences(workspaceRoot, {
    executionMode: 'planning',
    reviewPolicy: 'request',
    autoApproveShell: false,
  });
}

export interface ResolvedEffort {
  effort: EffortLevel;
  source: 'config' | 'preference' | 'default';
}

function normalizeEffort(raw: unknown): EffortLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return v === 'low' || v === 'medium' || v === 'high' ? v : undefined;
}

/**
 * Resolve the active reasoning-depth level using config > preference > default.
 * Matches the precedence pattern set by `resolveTheme` and the `cli.quiet`
 * override.
 *
 * A garbled `cli.effort` value is treated as unset so users don't get
 * cryptic crashes — the per-workspace preference takes over.
 *
 * We read the raw file (not `readPreferences`) so we can distinguish a
 * preference that was explicitly written from the default that
 * `readPreferences` injects via its spread.
 */
export function resolveEffort(workspaceRoot?: string): ResolvedEffort {
  const cfgEffort = normalizeEffort(getRawCliKnobs().effort);
  if (cfgEffort) return { effort: cfgEffort, source: 'config' };
  if (workspaceRoot) {
    try {
      const stored = readJsonFile<Partial<Preferences>>(
        getCliStateFile(workspaceRoot, 'preferences.json'),
        {},
      );
      const prefEffort = normalizeEffort(stored.effort);
      if (prefEffort) return { effort: prefEffort, source: 'preference' };
    } catch {
      // Preferences file unreadable — fall through to default.
    }
  }
  return { effort: 'medium', source: 'default' };
}
