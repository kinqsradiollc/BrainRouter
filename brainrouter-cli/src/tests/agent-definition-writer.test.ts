import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findById } from '@kinqs/brainrouter-core/orchestration';
import { buildAgentDefinition } from '../orchestration/agentDefValidation.js';
import { writeProjectAgentDefinition } from '../orchestration/agentDefinitionWriter.js';

function withWorkspace(run: (workspace: string) => void): void {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-agent-writer-'));
  try {
    run(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function definition(prompt = 'Inspect project documentation.'): ReturnType<typeof buildAgentDefinition> {
  return buildAgentDefinition({
    id: 'doc-writer',
    displayName: 'Documentation writer',
    whenToUse: 'Use for project documentation.',
    prompt,
    defaultAccess: 'write',
    toolScope: { local: ['read_file', 'write_file'], mcp: [] },
    ownership: 'docs/**',
  });
}

test('project agent writer emits a canonical, private, runtime-loadable definition', () => {
  withWorkspace((workspace) => {
    const file = writeProjectAgentDefinition(workspace, definition());
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { delegateName: string };

    assert.equal(parsed.delegateName, 'delegate_doc_writer');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(findById('doc-writer', workspace)?.def.delegateName, 'delegate_doc_writer');
  });
});

test('project agent writer is create-only unless force is explicit', () => {
  withWorkspace((workspace) => {
    const file = writeProjectAgentDefinition(workspace, definition('Original prompt.'));
    const original = fs.readFileSync(file, 'utf8');

    assert.throws(
      () => writeProjectAgentDefinition(workspace, definition('Replacement prompt.')),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original);

    writeProjectAgentDefinition(workspace, definition('Replacement prompt.'), { force: true });
    assert.match(fs.readFileSync(file, 'utf8'), /Replacement prompt\./);
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });
});

test('project agent writer rejects linked metadata ancestors without touching the target', () => {
  withWorkspace((workspace) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-agent-writer-outside-'));
    try {
      fs.symlinkSync(outside, path.join(workspace, '.brainrouter'));
      assert.throws(
        () => writeProjectAgentDefinition(workspace, definition()),
        /Unsafe workspace|symbolic link/i,
      );
      assert.equal(fs.existsSync(path.join(outside, 'agents', 'doc-writer.json')), false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('project agent writer rejects definitions the runtime cannot load before creating files', () => {
  withWorkspace((workspace) => {
    assert.throws(
      () => writeProjectAgentDefinition(workspace, definition('x'.repeat(70 * 1024))),
      /Agent definition must be 1-65536 bytes/,
    );
    assert.equal(fs.existsSync(path.join(workspace, '.brainrouter')), false);
  });
});
