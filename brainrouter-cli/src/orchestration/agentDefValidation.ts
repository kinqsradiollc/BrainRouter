/**
 * CLI-13 (0.4.3) — validation for `/agents create` / `/pack create`.
 *
 * Pure: validate a proposed scoped agent definition (required fields, id shape,
 * access mode, tool-scope coherence) BEFORE it's written or used. This is the
 * gate the interactive wizard (inquirer prompts + writing the def file) builds
 * on — the wizard flow + dry-run are the follow-up (interactive, verified live).
 */

const ACCESS_MODES = ['read', 'write', 'shell'];

export interface AgentDefDraft {
  id?: string;
  displayName?: string;
  whenToUse?: string;
  prompt?: string;
  defaultAccess?: string;
  toolScope?: { local?: string[]; mcp?: string[] };
  disallowedTools?: string[];
  maxIterations?: number;
  timeoutMs?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAgentDefinition(def: AgentDefDraft): ValidationResult {
  const errors: string[] = [];
  const req = (v: unknown, field: string) => {
    if (typeof v !== 'string' || v.trim() === '') errors.push(`${field} is required`);
  };
  req(def.id, 'id');
  if (typeof def.id === 'string' && def.id && !/^[a-z0-9][a-z0-9-]*$/.test(def.id)) {
    errors.push('id must be kebab-case (lowercase letters, digits, hyphens)');
  }
  req(def.displayName, 'displayName');
  req(def.whenToUse, 'whenToUse');
  req(def.prompt, 'prompt');

  if (def.defaultAccess !== undefined && !ACCESS_MODES.includes(def.defaultAccess)) {
    errors.push(`defaultAccess must be one of ${ACCESS_MODES.join(' / ')}`);
  }

  const local = def.toolScope?.local ?? [];
  const mcp = def.toolScope?.mcp ?? [];
  if (!Array.isArray(local) || !Array.isArray(mcp)) {
    errors.push('toolScope.local and toolScope.mcp must be arrays');
  } else {
    // Tool-scope coherence: a tool can't be both granted and disallowed.
    const granted = new Set([...local, ...mcp]);
    const overlap = (def.disallowedTools ?? []).filter((t) => granted.has(t));
    if (overlap.length) errors.push(`disallowedTools overlaps toolScope: ${overlap.join(', ')}`);
  }

  for (const [field, v] of [['maxIterations', def.maxIterations], ['timeoutMs', def.timeoutMs]] as const) {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      errors.push(`${field} must be a positive number`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** A complete AgentDefinition (the JSON `/agents create` writes), defaults filled. */
export interface BuiltAgentDefinition {
  id: string;
  displayName: string;
  whenToUse: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  defaultAccess: string;
  toolScope: { local: string[]; mcp: string[] };
  disallowedTools: string[];
  maxIterations: number;
  timeoutMs: number;
  maxResultChars: number;
  subagents: string[];
  delegateName: string;
  tier: string;
  outputContract: unknown;
}

/**
 * CLI-13 — fill a validated draft into the complete AgentDefinition shape the
 * registry loads (sensible defaults for the fields the create flow doesn't ask).
 * Call only after `validateAgentDefinition` passes.
 */
export function buildAgentDefinition(draft: AgentDefDraft): BuiltAgentDefinition {
  const id = draft.id!;
  return {
    id,
    displayName: draft.displayName ?? id,
    whenToUse: draft.whenToUse ?? '',
    prompt: draft.prompt ?? '',
    model: null,
    effort: null,
    defaultAccess: draft.defaultAccess ?? 'read',
    toolScope: { local: draft.toolScope?.local ?? [], mcp: draft.toolScope?.mcp ?? [] },
    disallowedTools: draft.disallowedTools ?? [],
    maxIterations: draft.maxIterations ?? 25,
    timeoutMs: draft.timeoutMs ?? 300_000,
    maxResultChars: 30_000,
    subagents: [],
    delegateName: id,
    tier: 'worker',
    outputContract: null,
  };
}
