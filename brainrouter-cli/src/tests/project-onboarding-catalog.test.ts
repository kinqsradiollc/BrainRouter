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
import {
  requestCatalogChoice,
  requestCatalogSelection,
} from '../cli/commands/init/projectOnboardingCatalog.js';

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

test('CLI persona choice uses catalog rows and supports an empty Custom default', async () => {
  let request: ProjectOnboardingPromptRequest | undefined;
  const prompt: ProjectOnboardingPrompt = async (value) => {
    request = value;
    return { kind: 'submit', value: '__none__' };
  };
  const personaCatalog: WorkspaceSelectionCatalog = {
    entries: [{
      id: 'researcher',
      kind: 'persona',
      label: 'Researcher',
      description: 'Investigates source-grounded questions.',
      category: 'domain-personas',
      source: 'bundled',
      provenance: 'bundled-personas',
      persistable: true,
      selectable: true,
      runtimeAvailabilityPrerequisites: [],
    }],
    fingerprint: 'f'.repeat(64),
  };

  const selected = await requestCatalogChoice(
    prompt,
    personaCatalog,
    'persona-default',
    'Default domain persona',
    'persona',
    '',
    'PERSONA',
    true,
  );

  assert.equal(selected, '');
  assert.equal(request?.kind, 'choice');
  assert.deepEqual(request?.rows?.map((row) => row.id), ['__none__', 'researcher']);
  assert.equal(request?.initialChoice, '__none__');
});
