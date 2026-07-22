/**
 * the model proposal boundary must reject malformed or
 * over-broad output before any onboarding surface can present it for approval.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_PROPOSAL_MAX_COLLECTION_ENTRIES,
  ONBOARDING_PROPOSAL_MAX_RAW_BYTES,
  parseWorkspaceOnboardingProposal,
} from '../workspace/onboardingProposal.js';

const NOW = '2026-07-21T00:00:00.000Z';

function validProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile: 'engineering',
    reasons: ['The repository contains a web application.'],
    agents: { default: 'engineer', enabled: ['engineer'] },
    capabilities: { enabled: ['frontend'], disabled: [] },
    skills: { packs: ['engineering'], enabled: ['testing-skill'], disabled: [] },
    tools: { profiles: ['coding', 'browser'], deny: [] },
    memory: { tags: ['engineering'], captureHint: 'code' },
    ...overrides,
  };
}

test('assisted proposal extracts fenced JSON and normalizes through the manifest contract', () => {
  const raw = validProposal({
    agents: {
      default: 'frontend-builder',
      enabled: ['frontend-builder', 'reviewer', 'reviewer'],
    },
    capabilities: {
      enabled: ['frontend', 'frontend', 'future-capability'],
      disabled: ['frontend'],
    },
    skills: {
      packs: ['engineering', 'engineering'],
      enabled: ['testing-skill', 'blocked-skill', 'testing-skill'],
      disabled: ['blocked-skill', 'blocked-skill'],
    },
    tools: {
      profiles: ['coding', 'browser', 'coding'],
      deny: ['dangerous-tool', 'dangerous-tool'],
    },
    memory: {
      tags: ['engineering', 'engineering', 'ui'],
      captureHint: 'code',
    },
    instructions: {
      path: './docs/AGENT.md',
      contents: '# Project instructions\n',
    },
  });

  const proposal = parseWorkspaceOnboardingProposal(
    `Here is the proposal:\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``,
    {
      workspaceName: 'example',
      selectedInstructionPath: 'docs/AGENT.md',
      at: NOW,
    },
  );

  assert.ok(proposal);
  assert.equal(proposal.source, 'model');
  assert.equal(proposal.manifest.onboarded.at, NOW);
  assert.equal(proposal.manifest.onboarded.by, 'agent');
  assert.equal(proposal.manifest.agents.default, 'engineer');
  assert.deepEqual(proposal.manifest.agents.enabled, ['engineer', 'reviewer']);
  assert.deepEqual(proposal.manifest.capabilities.enabled, ['future-capability']);
  assert.deepEqual(proposal.manifest.capabilities.disabled, ['frontend']);
  assert.deepEqual(proposal.manifest.skills.packs, ['engineering']);
  assert.deepEqual(proposal.manifest.skills.enabled, ['testing-skill']);
  assert.deepEqual(proposal.manifest.skills.disabled, ['blocked-skill']);
  assert.deepEqual(proposal.manifest.tools.profiles, ['coding', 'browser']);
  assert.deepEqual(proposal.manifest.tools.deny, ['dangerous-tool']);
  assert.deepEqual(proposal.manifest.memory.tags, ['engineering', 'ui']);
  assert.equal(JSON.stringify(proposal).includes('frontend-builder'), false);
  assert.deepEqual(proposal.instruction, {
    path: 'docs/AGENT.md',
    contents: '# Project instructions\n',
  });
  assert.equal(proposal.instruction.path, proposal.manifest.instructions);
});

test('assisted proposal rejects unknown fields and unknown profiles', () => {
  assert.equal(
    parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({ writes: [] })), {
      workspaceName: 'example',
      selectedInstructionPath: 'AGENT.md',
      at: NOW,
    }),
    null,
  );
  assert.equal(
    parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({ profile: 'frontend' })), {
      workspaceName: 'example',
      selectedInstructionPath: 'AGENT.md',
      at: NOW,
    }),
    null,
  );
});

test('assisted proposal rejects oversized raw output before extraction', () => {
  const oversized = `${' '.repeat(ONBOARDING_PROPOSAL_MAX_RAW_BYTES)}{}`;
  assert.equal(
    parseWorkspaceOnboardingProposal(oversized, {
      workspaceName: 'example',
      selectedInstructionPath: 'AGENT.md',
      at: NOW,
    }),
    null,
  );
});

test('assisted proposal rejects an invalid manifest timestamp', () => {
  assert.equal(
    parseWorkspaceOnboardingProposal(JSON.stringify(validProposal()), {
      workspaceName: 'example',
      selectedInstructionPath: 'AGENT.md',
      at: 'not-a-date',
    }),
    null,
  );
});

test('assisted proposal enforces collection, identifier, and string caps', () => {
  const tooMany = Array.from(
    { length: ONBOARDING_PROPOSAL_MAX_COLLECTION_ENTRIES + 1 },
    (_, index) => `skill-${index}`,
  );
  assert.equal(
    parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({
      skills: { packs: [], enabled: tooMany, disabled: [] },
    })), {
      workspaceName: 'example',
      selectedInstructionPath: 'AGENT.md',
      at: NOW,
    }),
    null,
  );
  assert.equal(
    parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({
      agents: { default: '../engineer', enabled: [] },
    })), {
      workspaceName: 'example',
      selectedInstructionPath: 'AGENT.md',
      at: NOW,
    }),
    null,
  );
  assert.equal(
    parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({
      reasons: ['x'.repeat(513)],
    })), {
      workspaceName: 'example',
      selectedInstructionPath: 'AGENT.md',
      at: NOW,
    }),
    null,
  );
  assert.equal(
    parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({
      reasons: ['looks safe\u001b[2J'],
    })), {
      workspaceName: 'example',
      selectedInstructionPath: 'AGENT.md',
      at: NOW,
    }),
    null,
  );
});

test('assisted proposal permits only the selected safe instruction target', () => {
  const paths = [
    '../AGENT.md',
    '/tmp/AGENT.md',
    'C:\\private\\AGENT.md',
    '.brainrouter/workspace.json',
    '.brainrouter/WORKSPACE.JSON',
    'OTHER.md',
  ];
  for (const instructionPath of paths) {
    const proposal = validProposal({
      instructions: { path: instructionPath, contents: '# Proposed\n' },
    });
    assert.equal(
      parseWorkspaceOnboardingProposal(JSON.stringify(proposal), {
        workspaceName: 'example',
        selectedInstructionPath: 'AGENT.md',
        at: NOW,
      }),
      null,
      `${instructionPath} must not escape or replace the selected target`,
    );
  }
});

test('assisted proposal rejects an instruction draft when instructions are disabled', () => {
  assert.equal(
    parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({
      instructions: { path: 'AGENT.md', contents: '# Proposed\n' },
    })), {
      workspaceName: 'example',
      selectedInstructionPath: '',
      at: NOW,
    }),
    null,
  );

  const proposal = parseWorkspaceOnboardingProposal(JSON.stringify(validProposal()), {
    workspaceName: 'example',
    selectedInstructionPath: '',
    at: NOW,
  });
  assert.ok(proposal);
  assert.equal(proposal.manifest.instructions, '');
  assert.equal(proposal.instruction, undefined);
});

test('assisted proposal rejects unsafe instruction-file control characters', () => {
  for (const contents of ['# Proposed\n\u0000', '# Forged\rstatus']) {
    assert.equal(
      parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({
        instructions: { path: 'AGENT.md', contents },
      })), {
        workspaceName: 'example',
        selectedInstructionPath: 'AGENT.md',
        at: NOW,
      }),
      null,
    );
  }
});

test('assisted proposal rejects credential material in instruction drafts', () => {
  const secrets = [
    'DATABASE_URL=postgres://user:password@database.example/app',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payloadpayload.signaturepart',
    'GOOGLE_API_KEY=AIzaSyD1234567890abcdefghijklmnop',
  ];
  for (const secret of secrets) {
    assert.equal(
      parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({
        instructions: { path: 'AGENT.md', contents: `# Proposed\n${secret}\n` },
      })), {
        workspaceName: 'example',
        selectedInstructionPath: 'AGENT.md',
        at: NOW,
      }),
      null,
      `instruction draft must reject ${secret.split('=')[0]}`,
    );
  }
});

test('assisted proposal rejects instruction targets the manifest would rewrite or alias', () => {
  const unsafeTargets = [
    '~/AGENT.md',
    'sk-abcdefghijkl/AGENT.md',
    '.BRAINROUTER/workspace.json',
    '.brainrouter./workspace.json',
    '.brainrouter/workspace.json.',
    '.brainrouter /workspace.json',
  ];
  for (const target of unsafeTargets) {
    assert.equal(
      parseWorkspaceOnboardingProposal(JSON.stringify(validProposal({
        instructions: { path: target, contents: '# Proposed\n' },
      })), {
        workspaceName: 'example',
        selectedInstructionPath: target,
        at: NOW,
      }),
      null,
      `${target} must not diverge from or alias the manifest instruction pointer`,
    );
  }
});
