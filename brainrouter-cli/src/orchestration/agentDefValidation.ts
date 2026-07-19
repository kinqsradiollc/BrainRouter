/**
 * CLI-13 (0.4.3) — validation for `/agents create` / `/pack create`.
 *
 * Pure: validate a proposed scoped agent definition (required fields, id shape,
 * access mode, tool-scope coherence) BEFORE it's written or used. This is the
 * gate the interactive wizard (inquirer prompts + writing the def file) builds
 * on — the wizard flow + dry-run are the follow-up (interactive, verified live).
 */

const ACCESS_MODES = ['read', 'write', 'shell'];

const WRITE_ACCESS = new Set(['write', 'shell']);

export interface AgentDefDraft {
  id?: string;
  displayName?: string;
  whenToUse?: string;
  prompt?: string;
  defaultAccess?: string;
  toolScope?: { local?: string[]; mcp?: string[] };
  disallowedTools?: string[];
  /** AGENTS-WIZARD — default ownership glob for write/shell children spawned from this def. */
  ownership?: string;
  maxIterations?: number;
  timeoutMs?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** AGENTS-WIZARD — non-fatal advisories (unknown MCP tool, missing ownership, …). */
  warnings: string[];
}

/**
 * AGENTS-WIZARD — optional knowledge the wizard passes so tool-scope entries can
 * be checked against what actually exists. `knownLocalTools` is this build's
 * active extension tool registry; `knownMcpTools` is the currently-connected server's tool list.
 */
export interface ValidationContext {
  knownLocalTools?: string[];
  knownMcpTools?: string[];
}

export function validateAgentDefinition(def: AgentDefDraft, ctx?: ValidationContext): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
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

    // AGENTS-WIZARD — tool-scope EXISTENCE. An unknown LOCAL tool can never
    // resolve (the set is fixed in this build) → hard error. An unknown MCP
    // tool only fails if the connected server doesn't expose it, which varies
    // at run time → warning, not error.
    if (ctx?.knownLocalTools) {
      const known = new Set(ctx.knownLocalTools);
      for (const t of local) {
        if (!known.has(t)) errors.push(`unknown local tool "${t}" — not in this build's tool set`);
      }
    }
    if (ctx?.knownMcpTools) {
      const known = new Set(ctx.knownMcpTools);
      for (const t of mcp) {
        if (!known.has(t)) warnings.push(`MCP tool "${t}" is not exposed by the currently-connected server — it will only work when a server providing it is connected`);
      }
    }
  }

  // AGENTS-WIZARD — ownership. When set it must be a non-empty glob; when a
  // write/shell agent omits it, warn (its writes are unbounded unless the
  // spawner passes one — mirrors the spawn-time ownership requirement).
  if (def.ownership !== undefined) {
    if (typeof def.ownership !== 'string' || def.ownership.trim() === '') {
      errors.push('ownership must be a non-empty glob string when set (e.g. "src/payments/**")');
    }
  } else if (def.defaultAccess !== undefined && WRITE_ACCESS.has(def.defaultAccess)) {
    warnings.push(`${def.defaultAccess} agent has no ownership glob — its file writes are unbounded unless the spawner passes one`);
  }

  for (const [field, v] of [['maxIterations', def.maxIterations], ['timeoutMs', def.timeoutMs]] as const) {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      errors.push(`${field} must be a positive number`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
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
  /** AGENTS-WIZARD — default ownership glob (null = none; spawner may still pass one). */
  ownership: string | null;
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
    ownership: draft.ownership && draft.ownership.trim() !== '' ? draft.ownership.trim() : null,
    maxIterations: draft.maxIterations ?? 25,
    timeoutMs: draft.timeoutMs ?? 300_000,
    maxResultChars: 30_000,
    subagents: [],
    delegateName: id,
    tier: 'worker',
    outputContract: null,
  };
}

/**
 * AGENTS-WIZARD — render a human-readable dry-run of what `/agents create` would
 * write: the resolved definition's key fields + the prompt overlay the spawned
 * agent receives. Pure (returns the text) so the command layer just prints it
 * and the format is unit-testable. No file is written on a dry run.
 */
export function previewAgentDefinition(built: BuiltAgentDefinition): string {
  const lines: string[] = [];
  lines.push(`agent: ${built.id}  (${built.displayName})`);
  lines.push(`tier: ${built.tier}   access: ${built.defaultAccess}   ownership: ${built.ownership ?? '—'}`);
  const tools = [...built.toolScope.local, ...built.toolScope.mcp];
  lines.push(`tools: ${tools.length ? tools.join(', ') : '(inherits defaults)'}`);
  if (built.disallowedTools.length) lines.push(`disallowed: ${built.disallowedTools.join(', ')}`);
  lines.push(`limits: maxIterations=${built.maxIterations}, timeoutMs=${built.timeoutMs}`);
  lines.push(`whenToUse: ${built.whenToUse}`);
  lines.push('--- prompt overlay ---');
  lines.push(built.prompt);
  return lines.join('\n');
}
