import type { AccessMode, ExternalDirMode } from './execPolicy.js';

/**
 * POLICY-3 (0.4.4) — named, swappable policy presets. Each bundles the safety
 * knobs (access mode, sandbox, external-directory writes, egress allowlist) so
 * a user can flip the whole posture with `/policy <name>` instead of tuning
 * knobs individually. The decision primitives live in `execPolicy.ts`; this is
 * just the curated bundles + lookup.
 *
 * Note: file-write confinement (`externalDirWrites`) governs the file tools;
 * `shell` access mode is a separate, explicit trust the user grants — a shell
 * can of course write anywhere, so `workspace` keeps shell available but still
 * confines the structured file tools.
 */
export interface PolicyProfile {
  accessMode: AccessMode;
  sandbox: 'off' | 'on';
  externalDirWrites: ExternalDirMode;
  egressAllowlist: string[]; // [] = unrestricted
  description: string;
}

export const POLICY_PROFILES: Record<string, PolicyProfile> = {
  readonly: {
    accessMode: 'read',
    sandbox: 'on',
    externalDirWrites: 'deny',
    egressAllowlist: [],
    description: 'Read-only — no file writes, no shell, no child spawns.',
  },
  workspace: {
    accessMode: 'shell',
    sandbox: 'on',
    externalDirWrites: 'deny',
    egressAllowlist: [],
    description: 'Full capability, file tools confined to the workspace (writes outside are denied).',
  },
  trusted: {
    accessMode: 'shell',
    sandbox: 'off',
    externalDirWrites: 'allow',
    egressAllowlist: [],
    description: 'Trusted — full capability, external-directory writes allowed.',
  },
};

export function getPolicyProfile(name: string): PolicyProfile | null {
  return POLICY_PROFILES[(name ?? '').toLowerCase().trim()] ?? null;
}

export function profileNames(): string[] {
  return Object.keys(POLICY_PROFILES);
}
