/**
 * Pure renderer model for reviewed workspace onboarding.
 *
 * Electron owns filesystem access and validation. This module treats every
 * bridge response as unknown, hydrates only the complete editor contract, and
 * keeps the opaque three-part review revision attached to the eventual save.
 */

export interface OnboardingProfile {
  id: string;
  label: string;
  description: string;
  agents: { default: string; enabled: string[] };
  capabilities: { enabled: string[]; disabled: string[] };
  skills: { packs: string[]; enabled: string[]; disabled: string[] };
  tools: { profiles: string[]; deny: string[] };
  memory: { tags: string[]; captureHint: string };
}

export interface OnboardingDraft {
  profile: string;
  agents: { default: string; enabled: string[] };
  capabilities: { enabled: string[]; disabled: string[] };
  skills: { packs: string[]; enabled: string[]; disabled: string[] };
  tools: { profiles: string[]; deny: string[] };
  memory: { tags: string[]; captureHint: string };
  instructions: string;
}

export interface OnboardingReviewRevision {
  root: string;
  manifest: string;
  instruction: string;
}

export interface OnboardingInstructionSummary {
  path: 'AGENT.md';
  existed: boolean;
  bytes: number;
  sha256: string | null;
}

export interface OnboardingInstructionDraft {
  path: 'AGENT.md';
  contents: string;
}

export interface LoadedOnboardingEditor {
  profiles: OnboardingProfile[];
  existing: OnboardingDraft | null;
  draft: OnboardingDraft;
  revision: OnboardingReviewRevision;
  instructionSummary: OnboardingInstructionSummary;
  detected: { profile: string; reasons: string[] } | null;
}

export interface ParsedOnboardingProposal {
  draft: OnboardingDraft;
  instruction: OnboardingInstructionDraft | null;
  source: 'wizard' | 'agent';
  reasons: string[];
  fallbackReason?: string;
  markers: string[];
  scanStats: { filesRead?: number; bytesRead?: number; stoppedBy: string[] };
}

const DIGEST = /^[0-9a-f]{64}$/;
const MAX_LIST_ITEMS = 256;
export const ONBOARDING_DESCRIPTION_MAX_BYTES = 4 * 1024;
const FALLBACK_REASONS = new Set([
  'model-unavailable', 'model-timeout', 'model-error', 'invalid-model-output',
]);

export function parseOnboardingEditor(value: unknown): LoadedOnboardingEditor | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.profiles)) return null;
  const profiles = value.profiles.map(parseProfile);
  if (profiles.length === 0 || profiles.some((profile) => profile === null)) return null;
  const catalog = profiles as OnboardingProfile[];
  const review = isRecord(value.review) ? value.review : null;
  const revision = parseRevision(review?.revision);
  const instructionSummary = parseInstructionSummary(review?.instruction);
  if (!revision || !instructionSummary) return null;

  const existing = value.manifest === null || value.manifest === undefined
    ? null
    : parseOnboardingDraft(value.manifest);
  if (value.manifest !== null && value.manifest !== undefined && !existing) return null;
  const detected = parseSuggestion(value.suggestion);
  const selected = catalog.find((profile) => profile.id === detected?.profile) ?? catalog[0];
  const draft = existing ?? draftFromOnboardingProfile(selected);
  if (!draft) return null;
  return { profiles: catalog, existing, draft, revision, instructionSummary, detected };
}

export function parseOnboardingProposal(value: unknown): ParsedOnboardingProposal | null {
  if (!isRecord(value) || !isRecord(value.proposal)) return null;
  const draft = parseOnboardingDraft(value.proposal.manifest);
  if (!draft) return null;
  const source = value.proposal.source === 'model' ? 'agent' : 'wizard';
  const reasons = parseStringList(value.proposal.reasons, 12) ?? [];
  const scan = isRecord(value.scan) ? value.scan : null;
  const markers = parseStringList(scan?.markers, 64) ?? [];
  const stats = isRecord(scan?.stats) ? scan.stats : null;
  const stoppedBy = parseStringList(scan?.stoppedBy, 8) ?? [];
  const fallbackReason = typeof value.fallbackReason === 'string' && FALLBACK_REASONS.has(value.fallbackReason)
    ? value.fallbackReason
    : undefined;
  const filesRead = parseNonNegativeInteger(stats?.filesRead);
  const bytesRead = parseNonNegativeInteger(stats?.bytesRead);
  return {
    draft,
    instruction: parseInstructionDraft(value.proposal.instruction),
    source,
    reasons,
    ...(fallbackReason ? { fallbackReason } : {}),
    markers,
    scanStats: {
      ...(filesRead === undefined ? {} : { filesRead }),
      ...(bytesRead === undefined ? {} : { bytesRead }),
      stoppedBy,
    },
  };
}

/** Match the host's UTF-8 byte ceiling before starting a proposal request. */
export function onboardingDescriptionError(value: string): string | null {
  return new TextEncoder().encode(value.trim()).length > ONBOARDING_DESCRIPTION_MAX_BYTES
    ? `Project description exceeds ${ONBOARDING_DESCRIPTION_MAX_BYTES} bytes.`
    : null;
}

/** Human-readable, bounded status for the applied proposal and its scan. */
export function onboardingProposalStatus(proposal: ParsedOnboardingProposal): string {
  const parts = [proposal.source === 'agent'
    ? 'AI proposal applied. Review and edit every field before saving.'
    : 'Repository scan proposal applied. Review and edit every field before saving.'];
  if (proposal.scanStats.filesRead !== undefined) {
    parts.push(`Scanned ${proposal.scanStats.filesRead} files.`);
  }
  if (proposal.markers.length > 0) parts.push(`Detected ${proposal.markers.join(', ')}.`);
  if (proposal.fallbackReason) {
    parts.push('The managed model was unavailable or returned an invalid response, so the deterministic proposal was used.');
  }
  if (proposal.instruction) {
    parts.push('An instruction-file proposal is available but is not included until its exact diff is reviewed.');
  }
  return parts.join(' ');
}

export function draftFromOnboardingProfile(profile: OnboardingProfile | undefined): OnboardingDraft | null {
  if (!profile) return null;
  return {
    profile: profile.id,
    agents: { default: profile.agents.default, enabled: [...profile.agents.enabled] },
    capabilities: { enabled: [...profile.capabilities.enabled], disabled: [...profile.capabilities.disabled] },
    skills: { packs: [...profile.skills.packs], enabled: [...profile.skills.enabled], disabled: [...profile.skills.disabled] },
    tools: { profiles: [...profile.tools.profiles], deny: [...profile.tools.deny] },
    memory: { tags: [...profile.memory.tags], captureHint: profile.memory.captureHint },
    instructions: 'AGENT.md',
  };
}

export function parseOnboardingDraft(value: unknown): OnboardingDraft | null {
  if (!isRecord(value)) return null;
  const agents = isRecord(value.agents) ? value.agents : null;
  const capabilities = isRecord(value.capabilities) ? value.capabilities : null;
  const skills = isRecord(value.skills) ? value.skills : null;
  const tools = isRecord(value.tools) ? value.tools : null;
  const memory = isRecord(value.memory) ? value.memory : null;
  if (!boundedString(value.profile, 128) || !agents || !capabilities || !skills || !tools || !memory ||
      !boundedString(agents.default, 128, true) || !boundedString(memory.captureHint, 256, true) ||
      !boundedString(value.instructions, 512)) return null;
  const enabledAgents = parseStringList(agents.enabled);
  const enabledCapabilities = parseStringList(capabilities.enabled);
  const disabledCapabilities = parseStringList(capabilities.disabled, MAX_LIST_ITEMS, true);
  const packs = parseStringList(skills.packs);
  const enabledSkills = parseStringList(skills.enabled);
  const disabledSkills = parseStringList(skills.disabled, MAX_LIST_ITEMS, true);
  const profiles = parseStringList(tools.profiles);
  const deniedTools = parseStringList(tools.deny, MAX_LIST_ITEMS, true);
  const tags = parseStringList(memory.tags);
  if (!enabledAgents || !enabledCapabilities || !disabledCapabilities || !packs || !enabledSkills ||
      !disabledSkills || !profiles || !deniedTools || !tags) return null;
  return {
    profile: value.profile,
    agents: { default: agents.default, enabled: enabledAgents },
    capabilities: { enabled: enabledCapabilities, disabled: disabledCapabilities },
    skills: { packs, enabled: enabledSkills, disabled: disabledSkills },
    tools: { profiles, deny: deniedTools },
    memory: { tags, captureHint: memory.captureHint },
    instructions: value.instructions,
  };
}

export function onboardingSavePayload(options: {
  draft: OnboardingDraft;
  revision: OnboardingReviewRevision;
  source: 'wizard' | 'agent';
  instruction?: OnboardingInstructionDraft | null;
  includeInstruction?: boolean;
}): Record<string, unknown> {
  return {
    expected: { ...options.revision },
    source: options.source,
    ...options.draft,
    ...(options.includeInstruction && options.instruction
      ? { instruction: { ...options.instruction } }
      : {}),
  };
}

export function onboardingDraftPreview(draft: OnboardingDraft): string {
  return JSON.stringify(draft, null, 2);
}

export function parseOnboardingCsv(value: string): string[] {
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
}

function parseProfile(value: unknown): OnboardingProfile | null {
  const draft = parseOnboardingDraft(isRecord(value)
    ? { ...value, profile: value.id, instructions: 'AGENT.md' }
    : value);
  if (!draft || !isRecord(value) || !boundedString(value.label, 128) || !boundedString(value.description, 2048, true)) return null;
  return {
    id: draft.profile,
    label: value.label,
    description: value.description,
    agents: draft.agents,
    capabilities: draft.capabilities,
    skills: draft.skills,
    tools: draft.tools,
    memory: draft.memory,
  };
}

function parseRevision(value: unknown): OnboardingReviewRevision | null {
  if (!isRecord(value) || !DIGEST.test(String(value.root)) || !DIGEST.test(String(value.manifest)) ||
      !DIGEST.test(String(value.instruction))) return null;
  return { root: String(value.root), manifest: String(value.manifest), instruction: String(value.instruction) };
}

function parseInstructionSummary(value: unknown): OnboardingInstructionSummary | null {
  if (!isRecord(value) || value.path !== 'AGENT.md' || typeof value.existed !== 'boolean' ||
      !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 ||
      !(value.sha256 === null || (typeof value.sha256 === 'string' && DIGEST.test(value.sha256)))) return null;
  return { path: 'AGENT.md', existed: value.existed, bytes: Number(value.bytes), sha256: value.sha256 as string | null };
}

function parseInstructionDraft(value: unknown): OnboardingInstructionDraft | null {
  if (!isRecord(value) || value.path !== 'AGENT.md' || typeof value.contents !== 'string') return null;
  return { path: 'AGENT.md', contents: value.contents };
}

function parseSuggestion(value: unknown): { profile: string; reasons: string[] } | null {
  if (!isRecord(value) || !boundedString(value.profile, 128)) return null;
  const reasons = parseStringList(value.reasons, 12);
  return reasons ? { profile: value.profile, reasons } : null;
}

function parseStringList(value: unknown, max = MAX_LIST_ITEMS, optional = false): string[] | null {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.length > max ||
      value.some((entry) => !boundedString(entry, 128, true))) return null;
  return value as string[];
}

function boundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) &&
    new TextEncoder().encode(value).length <= maxBytes;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
