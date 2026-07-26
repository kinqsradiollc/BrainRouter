/** Browser-development fixture for the production safe onboarding preview shape. */
import { WORKSPACE_PROFILES } from '@kinqs/brainrouter-core/dist/workspace/profiles.js';
import { parseOnboardingDraft } from '../components/dialogs/onboardingEditorModel.js';

const DEV_ONBOARDING_AT = '2026-01-01T00:00:00.000Z';
const DEV_ROLES = [
  ['architect', 'Architect', 'Decision-oriented design work.'],
  ['explorer', 'Explorer', 'Read-only investigation with evidence.'],
  ['fleet', 'Fleet executor', 'Unattended isolated execution.'],
  ['intake', 'Requirements intake', 'Turns a vague ask into a structured requirement.'],
  ['reviewer', 'Reviewer', 'Read-only critique against requirements.'],
  ['verifier', 'Verifier', 'Runs checks against acceptance criteria.'],
  ['worker', 'Worker', 'Produces one bounded artifact or change.'],
] as const;
const DEV_CAPABILITIES = [
  {
    id: 'frontend',
    label: 'Frontend',
    description: 'Task-time UI, accessibility, responsive, and browser-visual expertise.',
    expandsTo: ['frontend', 'a11y-skill', 'browser-testing-skill', 'taste-skill', 'browser', 'design'],
  },
  {
    id: 'backend',
    label: 'Backend',
    description: 'Task-time service, authorization, data, production, and backend-test expertise.',
    expandsTo: ['backend', 'api-service-design-skill', 'backend-testing-skill', 'coding', 'terminal'],
  },
] as const;
const DEV_TOOL_GROUPS = [
  {
    id: 'coding',
    label: 'Files and code',
    description: 'Inspect, edit, patch, and analyze source files and notebooks.',
    category: 'files-code',
    toolIds: ['read_file', 'list_dir', 'grep_search', 'glob_files', 'write_file', 'edit_file', 'apply_patch', 'notebook_edit', 'lsp'],
    extensionIds: [],
  },
  {
    id: 'terminal',
    label: 'Terminal and computer control',
    description: 'Run and monitor commands and available computer-control sessions.',
    category: 'terminal-computer',
    toolIds: ['run_command', 'task_output', 'wait_until', 'kill_command', 'computer_use', 'connector_run'],
    extensionIds: [],
  },
  {
    id: 'browser',
    label: 'Web and research',
    description: 'Fetch web pages and search public sources.',
    category: 'web-research',
    toolIds: ['fetch_url', 'web_search'],
    extensionIds: [],
  },
  {
    id: 'notes',
    label: 'Notes and artifacts',
    description: 'Capture research notes, briefs, and structured artifacts.',
    category: 'notes-artifacts',
    toolIds: ['research_note', 'research_brief', 'artifact_write'],
    extensionIds: [],
  },
  {
    id: 'design',
    label: 'Design and browser interaction',
    description: 'Create visual artifacts and use installed browser control.',
    category: 'design-browser',
    toolIds: ['artifact_write'],
    extensionIds: ['browser'],
  },
] as const;

export function devDraftForProfile(profileId: string, root: string): Record<string, unknown> {
  const profile = WORKSPACE_PROFILES.find((candidate) => candidate.id === profileId) ?? WORKSPACE_PROFILES[0]!;
  return {
    version: 2,
    name: root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'workspace',
    profile: profile.id,
    onboarded: { at: DEV_ONBOARDING_AT, by: 'wizard' },
    persona: { default: profile.persona.default, enabled: [...profile.persona.enabled] },
    orchestration: {
      mode: profile.orchestration.mode,
      availableRoles: [...profile.orchestration.availableRoles],
      disabledRoles: [...profile.orchestration.disabledRoles],
      maxParallel: profile.orchestration.maxParallel,
    },
    capabilities: { enabled: [...profile.capabilities.enabled], disabled: [] },
    skills: { packs: [...profile.skills.packs], enabled: [...profile.skills.enabled], disabled: [] },
    tools: { profiles: [...profile.tools.profiles], enabled: [], deny: [] },
    memory: { tags: [...profile.memory.tags], captureHint: profile.memory.captureHint },
    instructions: 'AGENT.md',
  };
}

export function buildDevOnboardingPreview(value: unknown): Record<string, unknown> {
  const draft = parseOnboardingDraft(value) ?? parseOnboardingDraft(devDraftForProfile('engineering', '/workspace'))!;
  const toolRows = new Map<string, Record<string, unknown>>();
  for (const group of DEV_TOOL_GROUPS) {
    for (const toolId of group.toolIds) {
      if (toolRows.has(toolId)) continue;
      toolRows.set(toolId, {
        id: toolId,
        kind: 'tool',
        label: labelForId(toolId),
        description: 'Built-in workspace tool.',
        category: group.category,
        source: 'core',
        provenance: 'workspace-tool-catalog',
        persistable: true,
        selectable: true,
        runtimeAvailabilityPrerequisites: [],
      });
    }
  }
  const skillIds = [...new Set(WORKSPACE_PROFILES.flatMap((profile) => profile.skills.enabled))];
  const packIds = [...new Set(WORKSPACE_PROFILES.flatMap((profile) => profile.skills.packs))];
  const selectedGroups = new Set(draft.tools.profiles);
  const selectedTools = new Set(draft.tools.enabled);
  const selectedCapabilities = new Set(draft.capabilities.enabled);
  const selectedPacks = new Set(draft.skills.packs);
  const selectedSkills = new Set(draft.skills.enabled);
  const denied = new Set(draft.tools.deny);
  const recommended = WORKSPACE_PROFILES.find((profile) => profile.id === draft.profile);
  const recommendedGroups = new Set(recommended?.tools.profiles ?? []);
  const recommendedRoles = new Set(recommended?.orchestration.availableRoles ?? []);
  const recommendedCapabilities = new Set(recommended?.capabilities.enabled ?? []);
  const recommendedPacks = new Set(recommended?.skills.packs ?? []);
  const recommendedSkills = new Set(recommended?.skills.enabled ?? []);
  const catalog = [
    ...DEV_ROLES.map(([id, label, description]) => {
      const selectable = draft.orchestration.mode !== 'off'
        && (recommended?.orchestration.availableRoles.includes(id) ?? false);
      return {
        id,
        kind: 'role',
        label,
        description,
        category: 'orchestration-roles',
        source: 'bundled',
        provenance: 'bundled-roles',
        persistable: true,
        selectable,
        ...(selectable ? {} : {
          blockedReason: draft.orchestration.mode === 'off'
            ? 'Delegation is off for this workspace.'
            : 'Not available in the selected orchestration plan.',
        }),
        runtimeAvailabilityPrerequisites: [],
        selected: draft.orchestration.availableRoles.includes(id),
        recommended: recommendedRoles.has(id),
        denied: draft.orchestration.disabledRoles.includes(id),
      };
    }),
    ...DEV_CAPABILITIES.map((capability) => {
      const selectable = draft.profile === 'custom'
        || recommendedCapabilities.has(capability.id);
      return {
        ...capability,
        kind: 'capability',
        category: 'workspace-capabilities',
        source: 'capability-plugin',
        provenance: `capability-${capability.id}`,
        persistable: true,
        selectable,
        ...(selectable ? {} : {
          blockedReason: 'Not contributed for the selected workspace profile.',
        }),
        runtimeAvailabilityPrerequisites: [],
        selected: selectedCapabilities.has(capability.id),
        recommended: recommendedCapabilities.has(capability.id),
        denied: draft.capabilities.disabled.includes(capability.id),
      };
    }),
    ...DEV_TOOL_GROUPS.map((group) => ({
      id: group.id,
      kind: 'tool-group',
      label: group.label,
      description: group.description,
      category: group.category,
      source: 'core',
      provenance: 'workspace-tool-groups',
      persistable: true,
      selectable: true,
      runtimeAvailabilityPrerequisites: [],
      expandsTo: [...group.toolIds, ...group.extensionIds.map((id) => `extension:${id}`)],
      selected: selectedGroups.has(group.id),
      recommended: recommendedGroups.has(group.id),
      denied: denied.has(group.id),
    })),
    ...[...toolRows.values()].map((row) => ({
      ...row,
      selected: selectedTools.has(String(row.id)),
      recommended: false,
      denied: denied.has(String(row.id)),
    })),
    ...packIds.map((id) => ({
      id,
      kind: 'skill-pack',
      label: labelForId(id),
      description: 'Bundled skills recommended for this workspace profile.',
      category: 'skill-packs',
      source: 'bundled',
      provenance: 'bundled-skills',
      persistable: true,
      selectable: true,
      runtimeAvailabilityPrerequisites: [],
      expandsTo: skillIds,
      selected: selectedPacks.has(id),
      recommended: recommendedPacks.has(id),
      denied: false,
    })),
    ...skillIds.map((id) => ({
      id,
      kind: 'skill',
      label: labelForId(id),
      description: 'Bundled workspace skill.',
      category: 'skills',
      source: 'bundled',
      provenance: 'bundled-skills',
      persistable: true,
      selectable: true,
      runtimeAvailabilityPrerequisites: [],
      selected: selectedSkills.has(id),
      recommended: recommendedSkills.has(id),
      denied: draft.skills.disabled.includes(id),
    })),
  ];
  const groupTools = DEV_TOOL_GROUPS
    .filter((group) => selectedGroups.has(group.id))
    .flatMap((group) => [...group.toolIds]);
  const deniedTools = new Set([
    ...denied,
    ...DEV_TOOL_GROUPS
      .filter((group) => denied.has(group.id))
      .flatMap((group) => [...group.toolIds]),
  ]);
  const fallback = fallbackForProfile(draft.profile);
  return {
    profileId: draft.profile,
    plan: {
      id: draft.profile,
      displayName: `${labelForId(draft.profile)} orchestration`,
      mode: draft.orchestration.mode,
      selectedStrategyId: fallback.strategyId,
      selectionReason: draft.orchestration.mode === 'off' ? 'mode-off' : 'setup-preview-fallback',
      source: { kind: 'bundled', provenance: 'bundled' },
      strategies: [{
        id: fallback.strategyId,
        description: 'Keep setup on the primary agent until task evidence selects another eligible strategy.',
        stages: [{
          id: fallback.stageId,
          executorKind: 'primary',
          skillIds: [],
          optional: false,
          maxChildren: 0,
        }],
      }],
    },
    roles: {
      planAvailable: [...draft.orchestration.availableRoles],
      manifestAvailable: [...draft.orchestration.availableRoles],
      disabled: [...draft.orchestration.disabledRoles],
      effective: draft.orchestration.availableRoles
        .filter((id) => !draft.orchestration.disabledRoles.includes(id)),
    },
    skills: { effective: [...draft.skills.enabled], unavailablePacks: [] },
    tools: {
      mode: 'explicit-catalog',
      selectedGroups: [...draft.tools.profiles],
      effectiveToolIds: [...new Set([...groupTools, ...draft.tools.enabled])]
        .filter((id) => !deniedTools.has(id)),
      effectiveExtensionIds: [],
      deniedIds: [...deniedTools],
      migrationRequired: false,
    },
    ceilings: {
      planMaxParallel: recommended?.orchestration.maxParallel ?? 1,
      manifestMaxParallel: draft.orchestration.maxParallel,
      effectiveMaxParallel: Math.min(
        recommended?.orchestration.maxParallel ?? 1,
        draft.orchestration.maxParallel,
      ),
    },
    catalogFingerprint: 'd'.repeat(64),
    catalog,
  };
}

function fallbackForProfile(profileId: string): { strategyId: string; stageId: string } {
  if (profileId === 'research') return { strategyId: 'direct-answer', stageId: 'respond' };
  if (profileId === 'data-science') return { strategyId: 'direct-analysis', stageId: 'analyze' };
  if (profileId === 'study') return { strategyId: 'direct-tutoring', stageId: 'teach' };
  if (profileId === 'writing') return { strategyId: 'direct-writing', stageId: 'write' };
  return { strategyId: 'direct', stageId: 'complete' };
}

function labelForId(id: string): string {
  return id.split(/[-_]/g).map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : '').join(' ');
}
