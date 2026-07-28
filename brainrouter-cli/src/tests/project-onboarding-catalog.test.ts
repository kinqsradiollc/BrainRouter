import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  WorkspaceOnboardingCatalogRow,
  WorkspaceSelectionCatalog,
} from '@kinqs/brainrouter-core/workspace';
import type {
  ProjectOnboardingPrompt,
  ProjectOnboardingPromptRequest,
} from '../cli/commands/init/projectOnboard.js';
import { requestCatalogSelection } from '../cli/commands/init/projectOnboardingCatalog.js';

function catalog(selected: boolean): WorkspaceSelectionCatalog {
  const entry: WorkspaceOnboardingCatalogRow = {
    id: 'research-browser',
    kind: 'tool-group',
    label: 'Research browser',
    description: 'Bounded browser research.',
    category: 'browser',
    source: 'core',
    provenance: 'workspace-tool-groups',
    persistable: true,
    selectable: true,
    runtimeAvailabilityPrerequisites: [],
    selected,
    recommended: true,
    denied: false,
  };
  return { entries: [entry], fingerprint: 'f'.repeat(64) };
}

test('CLI catalog labels an unselected recommendation as an addition', async () => {
  let request: ProjectOnboardingPromptRequest | undefined;
  const prompt: ProjectOnboardingPrompt = async (value) => {
    request = value;
    return { kind: 'submit', value: [] };
  };

  await requestCatalogSelection(
    prompt,
    catalog(false),
    'tool-profiles',
    'Tool groups',
    'tool-group',
    [],
    'TOOLS',
    true,
  );

  assert.match(request?.rows?.[0]?.description ?? '', /Recommended addition\./);
});

test('CLI catalog labels an already selected recommendation as selected', async () => {
  let request: ProjectOnboardingPromptRequest | undefined;
  const prompt: ProjectOnboardingPrompt = async (value) => {
    request = value;
    return { kind: 'submit', value: ['research-browser'] };
  };

  await requestCatalogSelection(
    prompt,
    catalog(true),
    'tool-profiles',
    'Tool groups',
    'tool-group',
    ['research-browser'],
    'TOOLS',
    true,
  );

  assert.match(request?.rows?.[0]?.description ?? '', /Recommended selection\./);
});
