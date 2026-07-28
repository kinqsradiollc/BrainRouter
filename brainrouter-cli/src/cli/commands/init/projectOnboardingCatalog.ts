/** Catalog-backed selection prompts and safe CLI onboarding preview formatting. */
import chalk from 'chalk';
import {
  type WorkspaceOnboardingCatalogRow,
  type WorkspaceOnboardingPreview,
  type WorkspaceSelectionCatalog,
  type WorkspaceSelectionCatalogEntry,
} from '@kinqs/brainrouter-core/workspace';
import type { PickerRow } from '../../ink/prompt/runPicker.js';
import type {
  ProjectOnboardingPrompt,
  ProjectOnboardingPromptId,
} from './projectOnboard.js';
import { parseProjectOnboardingList } from './onboardingDraft.js';

export async function requestCatalogSelection(
  prompt: ProjectOnboardingPrompt,
  catalog: WorkspaceSelectionCatalog,
  id: ProjectOnboardingPromptId,
  title: string,
  kind: WorkspaceSelectionCatalogEntry['kind'] | WorkspaceSelectionCatalogEntry['kind'][],
  initial: string[],
  badge: string,
  requireSelectable: boolean,
  excludedIds: readonly string[] = [],
): Promise<string[] | null> {
  const kinds = new Set(Array.isArray(kind) ? kind : [kind]);
  const excluded = new Set(excludedIds);
  const entries = catalog.entries.filter((entry) =>
    kinds.has(entry.kind)
    && entry.persistable
    && !(entry.kind === 'skill-pack' && entry.managedByCapability)
    && !excluded.has(entry.id)
    && (!requireSelectable || entry.selectable));
  const selected = new Set(initial);
  const result = await prompt({
    id,
    kind: 'choice',
    title,
    subtitle: 'Use SPACE to toggle choices. ENTER confirms; an empty selection is allowed.',
    badge,
    rows: entries.map((entry) => catalogPickerRow(entry, selected.has(entry.id))),
    initialChoices: initial.filter((selectedId) =>
      entries.some((entry) => entry.id === selectedId)),
    multiSelect: true,
    allowEmptySelection: true,
  });
  if (result.kind !== 'submit') return null;
  if (Array.isArray(result.value)) return result.value;
  // Compatibility for programmatic prompt adapters written before multi-select.
  return parseProjectOnboardingList(result.value);
}

export function formatPlanPreview(preview: WorkspaceOnboardingPreview): string[] {
  if (!preview.plan) return ['  orchestration plan: unavailable'];
  const strategy = preview.plan.strategies.find(
    (candidate) => candidate.id === preview.plan?.selectedStrategyId,
  );
  const stages = strategy?.stages.map((stage) =>
    `${stage.id}→${stage.executorKind === 'primary' ? 'primary' : stage.roleId}${stage.optional ? '?' : ''}`)
    .join(', ') ?? '(none)';
  return [
    `  orchestration plan: ${preview.plan.displayName} (${preview.plan.id}); source: ${preview.plan.source.provenance}; setup strategy: ${preview.plan.selectedStrategyId}`,
    `  setup stages: ${stages}`,
    `  effective roles: ${formatList(preview.roles.effective)}`,
    `  effective skills: ${formatList(preview.skills.effective)}`,
    `  effective tools: ${formatList([...preview.tools.effectiveToolIds, ...preview.tools.effectiveExtensionIds.map((id) => `extension:${id}`)])}`,
    `  effective max parallel: ${preview.ceilings.effectiveMaxParallel} (plan ${preview.ceilings.planMaxParallel}, workspace ${preview.ceilings.manifestMaxParallel})`,
  ];
}

function catalogPickerRow(entry: WorkspaceSelectionCatalogEntry, selected: boolean): PickerRow {
  const recommended = (entry as WorkspaceOnboardingCatalogRow).recommended === true;
  const recommendation = recommended
    ? selected ? ' Recommended selection.' : ' Recommended addition.'
    : '';
  const expansion = entry.expandsTo?.length
    ? ` Includes: ${entry.expandsTo.join(', ')}.`
    : '';
  const unavailable = entry.blockedReason ? ` Unavailable: ${entry.blockedReason}` : '';
  return {
    id: entry.id,
    label: entry.label,
    value: entry.source,
    description: `${entry.description} [${entry.provenance}].${recommendation}${expansion}${unavailable}`,
  };
}

function formatList(values: string[]): string {
  return values.join(', ') || chalk.gray('(none)');
}
