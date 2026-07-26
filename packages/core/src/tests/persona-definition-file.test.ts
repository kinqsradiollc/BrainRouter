import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PERSONA_DEFINITION_MAX_BYTES,
  listPersonaDefinitionFiles,
  parsePersonaDefinition,
  readPersonaDefinitionFile,
} from '../workspace/personaDefinitionFile.js';
import {
  buildPersonaRegistry,
  findRegisteredPersona,
  type PersonaCandidate,
} from '../workspace/personaRegistry.js';

function withDirectory(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-persona-json-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function persona(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'persona',
    id,
    displayName: id === 'engineer' ? 'Engineer' : id,
    description: `${id} responsibilities`,
    instructions: ['Make evidence-based decisions.', 'Verify work in proportion to risk.'],
    priorities: ['correctness', 'security'],
    ...overrides,
  };
}

function writePersona(root: string, id: string, overrides: Record<string, unknown> = {}): string {
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(persona(id, overrides)), 'utf8');
  return filePath;
}

test('persona parser accepts the bounded schema and normalizes duplicate entries', () => {
  const parsed = parsePersonaDefinition(JSON.stringify(persona('engineer', {
    instructions: [' First instruction. ', 'First instruction.', 'Second instruction.'],
    priorities: undefined,
  })), 'engineer');

  assert.deepEqual(parsed, {
    schemaVersion: 1,
    kind: 'persona',
    id: 'engineer',
    displayName: 'Engineer',
    description: 'engineer responsibilities',
    instructions: ['First instruction.', 'Second instruction.'],
    priorities: [],
  });
});

test('persona parser rejects executable fields, reserved roles, mismatched ids, and secrets', () => {
  assert.throws(
    () => parsePersonaDefinition(JSON.stringify(persona('engineer', { defaultAccess: 'shell' })), 'engineer'),
    /unknown fields: defaultAccess/,
  );
  assert.throws(
    () => parsePersonaDefinition(JSON.stringify(persona('worker')), 'worker'),
    /reserved for an orchestration role/,
  );
  assert.throws(
    () => parsePersonaDefinition(JSON.stringify(persona('researcher')), 'engineer'),
    /match its filename/,
  );
  assert.throws(
    () => parsePersonaDefinition(JSON.stringify(persona('engineer', {
      instructions: ['Use token=super-secret-value for requests.'],
    })), 'engineer'),
    /secret material/,
  );
});

test('persona parser rejects malformed, oversized, and unsupported schemas', () => {
  assert.throws(() => parsePersonaDefinition('{ nope', 'engineer'), /not valid JSON/);
  assert.throws(
    () => parsePersonaDefinition(JSON.stringify(persona('engineer', { schemaVersion: 2 })), 'engineer'),
    /schemaVersion must be 1/,
  );
  assert.throws(
    () => parsePersonaDefinition(' '.repeat(PERSONA_DEFINITION_MAX_BYTES + 1), 'engineer'),
    /must be 1-/,
  );
  assert.throws(
    () => parsePersonaDefinition(JSON.stringify(persona('engineer', { instructions: [] })), 'engineer'),
    /must contain 1-64 entries/,
  );
});

test('persona file discovery and reads reject links and containment escapes', () => {
  withDirectory((root) => {
    const personasRoot = path.join(root, 'personas');
    const outsideRoot = path.join(root, 'outside');
    const valid = writePersona(personasRoot, 'engineer');
    const outside = writePersona(outsideRoot, 'researcher');
    fs.symlinkSync(outside, path.join(personasRoot, 'researcher.json'));

    assert.deepEqual(listPersonaDefinitionFiles(personasRoot, root), [valid]);
    assert.throws(
      () => readPersonaDefinitionFile(path.join(personasRoot, 'researcher.json'), personasRoot, root),
      /symbolic links|readable regular UTF-8/,
    );
    assert.throws(
      () => readPersonaDefinitionFile(outside, personasRoot, personasRoot),
      /escaped its declared personas directory/,
    );
  });
});

test('persona registry preserves precedence and reports invalid and shadowed candidates', () => {
  withDirectory((root) => {
    const workspaceFile = writePersona(path.join(root, 'workspace'), 'engineer', {
      instructions: ['Workspace instructions.'],
    });
    const bundledFile = writePersona(path.join(root, 'bundled'), 'engineer', {
      instructions: ['Bundled instructions.'],
    });
    const invalidFile = path.join(root, 'bundled', 'invalid.json');
    fs.writeFileSync(invalidFile, JSON.stringify(persona('different-id')), 'utf8');

    const candidates: PersonaCandidate[] = [
      { source: 'workspace', scope: 'workspace', filePath: workspaceFile },
      { source: 'bundled', scope: 'bundled', filePath: bundledFile },
      { source: 'bundled', scope: 'bundled', filePath: invalidFile },
    ];
    const registry = buildPersonaRegistry(candidates);

    assert.equal(registry.personas.length, 1);
    assert.deepEqual(findRegisteredPersona(registry, ' engineer ')?.instructions, ['Workspace instructions.']);
    assert.equal(registry.personas[0]?.collides, true);
    assert.deepEqual(registry.personas[0]?.shadowedBy, ['bundled']);
    assert.deepEqual(registry.diagnostics.map((diagnostic) => diagnostic.code), ['shadowed', 'invalid']);
  });
});
