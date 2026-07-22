/**
 * strict, bounded model proposals for workspace setup.
 *
 * Model output is untrusted. This module is the single boundary that extracts
 * one balanced JSON value, validates a closed shape, constrains every string
 * and collection, and normalizes the result through the workspace-manifest
 * chokepoint. It performs no filesystem writes; callers must show the proposal
 * and obtain explicit approval before using the onboarding transaction.
 */
import path from 'node:path';
import { z } from 'zod';
import { extractAtlasJson } from '../atlas/enrich/jsonExtract.js';
import {
  createWorkspaceManifest,
  type WorkspaceManifest,
} from './manifest.js';
import { WORKSPACE_PROFILES } from './profiles.js';
import { containsWorkspaceSecretMaterial } from './workspaceContentSafety.js';

export const ONBOARDING_PROPOSAL_MAX_RAW_BYTES = 96 * 1024;
export const ONBOARDING_PROPOSAL_MAX_COLLECTION_ENTRIES = 32;
export const ONBOARDING_PROPOSAL_MAX_INSTRUCTION_BYTES = 64 * 1024;
export const ONBOARDING_PROPOSAL_MAX_REASON_BYTES = 512;

const PROFILE_IDS = WORKSPACE_PROFILES.map((profile) => profile.id) as [
  (typeof WORKSPACE_PROFILES)[number]['id'],
  ...(typeof WORKSPACE_PROFILES)[number]['id'][],
];
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const DISPLAY_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_INSTRUCTION_CONTENT_PATTERN =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;
const MANIFEST_TARGET = '.brainrouter/workspace.json';

const identifierSchema = z.string().trim().min(1).max(128).regex(IDENTIFIER_PATTERN);
const identifierOrEmptySchema = z.union([identifierSchema, z.literal('')]);
const identifierListSchema = z.array(identifierSchema).max(ONBOARDING_PROPOSAL_MAX_COLLECTION_ENTRIES);
const reasonSchema = z.string().trim().min(1).max(ONBOARDING_PROPOSAL_MAX_REASON_BYTES).refine(
  (reason) => Buffer.byteLength(reason) <= ONBOARDING_PROPOSAL_MAX_REASON_BYTES,
  'Proposal reason exceeds the byte limit.',
).refine(
  (reason) => !DISPLAY_CONTROL_PATTERN.test(reason),
  'Proposal reason contains unsafe display controls.',
);
const instructionContentsSchema = z.string()
  .min(1)
  .refine(
    (contents) => Buffer.byteLength(contents) <= ONBOARDING_PROPOSAL_MAX_INSTRUCTION_BYTES,
    'Instruction proposal exceeds the byte limit.',
  )
  .refine(
    (contents) => !UNSAFE_INSTRUCTION_CONTENT_PATTERN.test(contents),
    'Instruction proposal contains unsafe control characters.',
  )
  .refine(
    (contents) => !containsWorkspaceSecretMaterial(contents),
    'Instruction proposal contains credential material.',
  );

/** Closed model-output shape. Unknown write targets and extra fields fail. */
export const WorkspaceOnboardingModelProposalSchema = z.object({
  profile: z.enum(PROFILE_IDS),
  reasons: z.array(reasonSchema).min(1).max(12),
  agents: z.object({
    default: identifierOrEmptySchema,
    enabled: identifierListSchema,
  }).strict(),
  capabilities: z.object({
    enabled: identifierListSchema,
    disabled: identifierListSchema,
  }).strict(),
  skills: z.object({
    packs: identifierListSchema,
    enabled: identifierListSchema,
    disabled: identifierListSchema,
  }).strict(),
  tools: z.object({
    profiles: identifierListSchema,
    deny: identifierListSchema,
  }).strict(),
  memory: z.object({
    tags: identifierListSchema,
    captureHint: z.string().trim().max(256).refine(
      (hint) => Buffer.byteLength(hint) <= 256,
      'Memory capture hint exceeds the byte limit.',
    ).refine(
      (hint) => !DISPLAY_CONTROL_PATTERN.test(hint),
      'Memory capture hint contains unsafe display controls.',
    ),
  }).strict(),
  instructions: z.object({
    path: z.string().trim().min(1).max(512),
    contents: instructionContentsSchema,
  }).strict().optional(),
}).strict();

export interface WorkspaceInstructionProposal {
  path: string;
  /** Full desired contents; the client derives and presents the visible diff. */
  contents: string;
}

export interface WorkspaceOnboardingProposal {
  source: 'model' | 'deterministic';
  manifest: WorkspaceManifest;
  reasons: string[];
  instruction?: WorkspaceInstructionProposal;
}

export interface ParseWorkspaceOnboardingProposalOptions {
  workspaceName: string;
  /** Empty disables instruction-file proposals for this run. */
  selectedInstructionPath: string;
  /** Stable timestamp supplied by the orchestration boundary. */
  at: string;
}

/**
 * Parse one untrusted model reply. Invalid, oversized, or over-broad output is
 * rejected as `null`, allowing the service to use its deterministic fallback.
 */
export function parseWorkspaceOnboardingProposal(
  raw: string,
  options: ParseWorkspaceOnboardingProposalOptions,
): WorkspaceOnboardingProposal | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > ONBOARDING_PROPOSAL_MAX_RAW_BYTES) {
    return null;
  }
  const extracted = extractAtlasJson(raw);
  const parsed = WorkspaceOnboardingModelProposalSchema.safeParse(extracted);
  if (!parsed.success) return null;
  const atMs = Date.parse(options.at);
  if (!Number.isFinite(atMs)) return null;

  const selectedInstructionPath = normalizeWorkspaceInstructionTarget(options.selectedInstructionPath);
  if (selectedInstructionPath === null) return null;
  let instruction: WorkspaceInstructionProposal | undefined;
  if (parsed.data.instructions) {
    const proposedPath = normalizeInstructionTarget(parsed.data.instructions.path, false);
    if (!selectedInstructionPath || proposedPath !== selectedInstructionPath) return null;
    instruction = {
      path: proposedPath,
      contents: parsed.data.instructions.contents,
    };
  }

  const disabledCapabilities = unique(parsed.data.capabilities.disabled);
  const disabledCapabilitySet = new Set(disabledCapabilities);
  const disabledSkills = unique(parsed.data.skills.disabled);
  const disabledSkillSet = new Set(disabledSkills);
  const legacyFrontendPersona = parsed.data.agents.default === 'frontend-builder' ||
    parsed.data.agents.enabled.includes('frontend-builder');
  const agentDefault = normalizeLegacyAgent(parsed.data.agents.default);
  const enabledAgents = unique(parsed.data.agents.enabled.map(normalizeLegacyAgent).filter(Boolean));
  if (agentDefault && !enabledAgents.includes(agentDefault)) enabledAgents.unshift(agentDefault);

  const manifest = createWorkspaceManifest({
    name: options.workspaceName,
    profile: parsed.data.profile,
    by: 'agent',
    at: new Date(atMs).toISOString(),
    overrides: {
      agents: {
        default: agentDefault,
        enabled: enabledAgents.slice(0, ONBOARDING_PROPOSAL_MAX_COLLECTION_ENTRIES),
      },
      capabilities: {
        enabled: unique([
          ...parsed.data.capabilities.enabled,
          ...(legacyFrontendPersona ? ['frontend'] : []),
        ])
          .filter((capability) => !disabledCapabilitySet.has(capability)),
        disabled: disabledCapabilities,
      },
      skills: {
        packs: unique(parsed.data.skills.packs),
        enabled: unique(parsed.data.skills.enabled).filter((skill) => !disabledSkillSet.has(skill)),
        disabled: disabledSkills,
      },
      tools: {
        profiles: unique(parsed.data.tools.profiles),
        deny: unique(parsed.data.tools.deny),
      },
      memory: {
        tags: unique(parsed.data.memory.tags),
        captureHint: parsed.data.memory.captureHint,
      },
      instructions: selectedInstructionPath,
    },
  });
  if (manifest.instructions !== selectedInstructionPath ||
      (instruction && instruction.path !== manifest.instructions)) return null;

  return {
    source: 'model',
    manifest,
    reasons: unique(parsed.data.reasons),
    ...(instruction ? { instruction } : {}),
  };
}

function normalizeLegacyAgent(agent: string): string {
  return agent === 'frontend-builder' ? 'engineer' : agent;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Validate and normalize the caller-selected project-relative instruction path. */
export function normalizeWorkspaceInstructionTarget(candidate: string): string | null {
  return normalizeInstructionTarget(candidate, true);
}

/**
 * Normalize a project-relative instruction pointer without silently turning an
 * unsafe model target into the default manifest pointer.
 */
function normalizeInstructionTarget(candidate: string, allowEmpty: boolean): string | null {
  if (typeof candidate !== 'string' || candidate.length > 512 || Buffer.byteLength(candidate) > 512) return null;
  const trimmed = candidate.trim();
  if (trimmed === '') return allowEmpty ? '' : null;
  if (DISPLAY_CONTROL_PATTERN.test(trimmed) ||
      path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    return null;
  }
  const normalized = path.posix.normalize(trimmed.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') ||
      normalized === '~' || normalized.startsWith('~/') ||
      isUnsafeWindowsPath(normalized) || isManifestTargetAlias(normalized)) {
    return null;
  }
  const normalizedByManifest = createWorkspaceManifest({
    name: 'workspace',
    profile: 'custom',
    by: 'agent',
    overrides: { instructions: normalized },
  }).instructions;
  return normalizedByManifest === normalized ? normalized : null;
}

function isUnsafeWindowsPath(candidate: string): boolean {
  return candidate.split('/').some((segment) => segment !== segment.replace(/[ .]+$/u, ''));
}

function isManifestTargetAlias(candidate: string): boolean {
  const windowsCanonical = candidate
    .split('/')
    .map((segment) => segment.replace(/[ .]+$/u, ''))
    .join('/')
    .toLowerCase();
  return windowsCanonical === MANIFEST_TARGET;
}
