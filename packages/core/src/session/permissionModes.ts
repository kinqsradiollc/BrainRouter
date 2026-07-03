/**
 * FRIENDLY PERMISSION MODES (§5.10) — a presentation + bidirectional-mapping
 * layer over BrainRouter's EXISTING permission engine. We do NOT introduce a
 * parallel policy engine: each friendly mode resolves to a tuple of the knobs we
 * already have —
 *   - `accessMode`        (read | write | shell)         — exec/execPolicy
 *   - `executionMode`     (planning | fast)              — session prefs
 *   - `reviewPolicy`      (request | proceed)            — session prefs
 *   - `sandbox`           (off | on)                     — cli.sandbox
 *   - `externalDirWrites` (deny | ask | allow)           — cli.externalDirWrites
 *
 * The UI shows five friendly cards; this module collapses a card → the engine
 * tuple (`policyForMode`) and, in reverse, resolves any stored tuple to the
 * NEAREST card for display (`nearestMode`). Pure data + pure functions, so the
 * mapping is unit-testable and shared verbatim by CLI and desktop.
 */

import type { AccessMode, ExternalDirMode } from '../exec/policy/execPolicy.js';
import type { ExecutionMode, ReviewPolicy } from './preferencesStore.js';

export type FriendlyPermissionMode =
  | 'read-only'
  | 'ask-each'
  | 'workspace-write'
  | 'sensitive-ask'
  | 'full-access';

/** The engine primitives a friendly mode resolves to — all PRE-EXISTING knobs. */
export interface EnginePermissionPolicy {
  accessMode: AccessMode;
  executionMode: ExecutionMode;
  reviewPolicy: ReviewPolicy;
  sandbox: 'off' | 'on';
  externalDirWrites: ExternalDirMode;
}

export interface PermissionModeDef {
  id: FriendlyPermissionMode;
  label: string;
  description: string;
  policy: EnginePermissionPolicy;
}

/**
 * The five friendly modes, ordered MOST-RESTRICTIVE → LEAST. Order is load-
 * bearing: `nearestMode` breaks ties toward the earlier (more restrictive) mode
 * so an ambiguous stored tuple never silently widens capability.
 */
export const PERMISSION_MODES: readonly PermissionModeDef[] = [
  {
    id: 'read-only',
    label: 'Read-only',
    description: 'Explore safely — no file edits, commands, or out-of-workspace writes. Sandboxed.',
    policy: { accessMode: 'read', executionMode: 'planning', reviewPolicy: 'request', sandbox: 'on', externalDirWrites: 'deny' },
  },
  {
    id: 'workspace-write',
    label: 'Workspace write',
    description: 'Edit files inside the workspace; no shell; writes confined to the project (sandboxed).',
    policy: { accessMode: 'write', executionMode: 'planning', reviewPolicy: 'request', sandbox: 'on', externalDirWrites: 'deny' },
  },
  {
    id: 'ask-each',
    label: 'Ask for everything',
    description: 'Full capability, but confirm every command and mutating action.',
    policy: { accessMode: 'shell', executionMode: 'planning', reviewPolicy: 'request', sandbox: 'off', externalDirWrites: 'ask' },
  },
  {
    id: 'sensitive-ask',
    label: 'Auto, ask on sensitive',
    description: 'Proceed automatically, but still confirm dangerous commands and out-of-workspace writes.',
    policy: { accessMode: 'shell', executionMode: 'fast', reviewPolicy: 'proceed', sandbox: 'off', externalDirWrites: 'ask' },
  },
  {
    id: 'full-access',
    label: 'Full access',
    description: 'No prompts — auto-approve everything, including out-of-workspace writes. Use with care.',
    policy: { accessMode: 'shell', executionMode: 'fast', reviewPolicy: 'proceed', sandbox: 'off', externalDirWrites: 'allow' },
  },
];

/** Look up a mode definition by id. */
export function getPermissionMode(id: FriendlyPermissionMode): PermissionModeDef | undefined {
  return PERMISSION_MODES.find((m) => m.id === id);
}

/** The engine tuple a friendly mode collapses to. */
export function policyForMode(id: FriendlyPermissionMode): EnginePermissionPolicy | undefined {
  return getPermissionMode(id)?.policy;
}

const FIELDS: ReadonlyArray<keyof EnginePermissionPolicy> = [
  'accessMode',
  'executionMode',
  'reviewPolicy',
  'sandbox',
  'externalDirWrites',
];

/**
 * Bidirectional mapping: given any (possibly partial) engine policy tuple, return
 * the friendly mode whose policy matches the MOST fields. Ties resolve to the
 * more restrictive mode (earlier in {@link PERMISSION_MODES}) because the scan
 * keeps the first maximum it sees — so an ambiguous stored state never silently
 * widens capability. Undefined fields in the input simply don't contribute.
 */
export function nearestMode(policy: Partial<EnginePermissionPolicy>): FriendlyPermissionMode {
  let best: PermissionModeDef = PERMISSION_MODES[0];
  let bestScore = -1;
  for (const mode of PERMISSION_MODES) {
    let score = 0;
    for (const field of FIELDS) {
      if (policy[field] !== undefined && policy[field] === mode.policy[field]) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = mode;
    }
  }
  return best.id;
}
