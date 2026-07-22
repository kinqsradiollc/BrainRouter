import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentDefinition, buildAgentDefinition, previewAgentDefinition } from '../orchestration/agentDefValidation.js';

const valid = {
  id: 'doc-writer',
  displayName: 'Doc Writer',
  whenToUse: 'When docs need updating',
  prompt: 'You write docs.',
  defaultAccess: 'write',
  toolScope: { local: ['read_file', 'write_file'], mcp: [] },
  disallowedTools: ['run_command'],
  maxIterations: 10,
  timeoutMs: 60000,
};

test('CLI-13 validateAgentDefinition: a well-formed def passes', () => {
  const r = validateAgentDefinition(valid);
  assert.equal(r.valid, true, r.errors.join('; '));
});

test('CLI-13 validateAgentDefinition: missing required fields + bad id', () => {
  const r = validateAgentDefinition({ id: 'Bad Id', toolScope: { local: [], mcp: [] } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /displayName is required/.test(e)));
  assert.ok(r.errors.some((e) => /prompt is required/.test(e)));
  assert.ok(r.errors.some((e) => /kebab-case/.test(e)));
});

test('CLI-13 validateAgentDefinition: ids use the runtime kebab-case grammar', () => {
  for (const id of ['trailing-', 'double--hyphen', '-leading']) {
    const r = validateAgentDefinition({ ...valid, id });
    assert.equal(r.valid, false, `${id} must be rejected before writing`);
    assert.ok(r.errors.some((e) => /kebab-case/.test(e)));
  }
});

test('CLI-13 validateAgentDefinition: invalid access mode + tool-scope overlap', () => {
  const r = validateAgentDefinition({ ...valid, defaultAccess: 'admin', disallowedTools: ['write_file'] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /defaultAccess must be one of/.test(e)));
  assert.ok(r.errors.some((e) => /disallowedTools overlaps toolScope: write_file/.test(e)));
});

test('CLI-13 validateAgentDefinition: non-positive numeric bounds', () => {
  const r = validateAgentDefinition({ ...valid, maxIterations: 0, timeoutMs: -5 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /maxIterations must be a positive number/.test(e)));
  assert.ok(r.errors.some((e) => /timeoutMs must be a positive number/.test(e)));
});

test('CLI-13 buildAgentDefinition: fills the complete def with sane defaults', () => {
  const def = buildAgentDefinition({ id: 'doc-writer', prompt: 'write docs', defaultAccess: 'write', toolScope: { local: ['read_file'], mcp: [] } });
  assert.equal(def.id, 'doc-writer');
  assert.equal(def.displayName, 'doc-writer'); // defaults to id
  assert.equal(def.defaultAccess, 'write');
  assert.deepEqual(def.toolScope, { local: ['read_file'], mcp: [] });
  assert.equal(def.tier, 'worker');
  assert.equal(def.model, null);
  assert.equal(def.maxIterations, 25);
  assert.equal(def.delegateName, 'delegate_doc_writer');
  assert.deepEqual(def.subagents, []);
  assert.equal(def.ownership, null); // none declared → null
});

test('AGENTS-WIZARD tool-scope existence: unknown local tool errors, unknown MCP tool warns', () => {
  const r = validateAgentDefinition(
    { ...valid, defaultAccess: 'read', disallowedTools: [], toolScope: { local: ['read_file', 'no_such_tool'], mcp: ['memory_search', 'mystery_mcp'] } },
    { knownLocalTools: ['read_file', 'write_file'], knownMcpTools: ['memory_search'] },
  );
  assert.equal(r.valid, false, 'unknown local tool is a hard error');
  assert.ok(r.errors.some((e) => /unknown local tool "no_such_tool"/.test(e)));
  assert.ok(r.warnings.some((w) => /mystery_mcp/.test(w)), 'unknown MCP tool is a warning, not error');
});

test('AGENTS-WIZARD tool-scope existence: all-known tools pass clean', () => {
  const r = validateAgentDefinition(
    { ...valid, defaultAccess: 'read', disallowedTools: [], toolScope: { local: ['read_file', 'write_file'], mcp: ['memory_search'] } },
    { knownLocalTools: ['read_file', 'write_file'], knownMcpTools: ['memory_search'] },
  );
  assert.equal(r.valid, true, r.errors.join('; '));
  assert.equal(r.warnings.length, 0);
});

test('AGENTS-WIZARD ownership: empty string errors; write/shell without ownership warns', () => {
  const empty = validateAgentDefinition({ ...valid, ownership: '   ' });
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((e) => /ownership must be a non-empty glob/.test(e)));

  const writeNoOwnership = validateAgentDefinition({ ...valid, defaultAccess: 'write', ownership: undefined });
  assert.equal(writeNoOwnership.valid, true);
  assert.ok(writeNoOwnership.warnings.some((w) => /no ownership glob/.test(w)));

  const writeWithOwnership = validateAgentDefinition({ ...valid, defaultAccess: 'write', ownership: 'src/docs/**' });
  assert.equal(writeWithOwnership.valid, true);
  assert.ok(!writeWithOwnership.warnings.some((w) => /no ownership glob/.test(w)));
});

test('AGENTS-WIZARD buildAgentDefinition: ownership persisted (trimmed) or null', () => {
  assert.equal(buildAgentDefinition({ id: 'a', prompt: 'p', ownership: '  src/x/** ' }).ownership, 'src/x/**');
  assert.equal(buildAgentDefinition({ id: 'a', prompt: 'p' }).ownership, null);
});

test('AGENTS-WIZARD previewAgentDefinition: shows resolved fields + prompt overlay', () => {
  const out = previewAgentDefinition(buildAgentDefinition({
    id: 'doc-writer', displayName: 'Doc Writer', whenToUse: 'docs', prompt: 'You write docs.',
    defaultAccess: 'write', ownership: 'docs/**', toolScope: { local: ['write_file'], mcp: [] },
  }));
  assert.match(out, /agent: doc-writer/);
  assert.match(out, /access: write/);
  assert.match(out, /ownership: docs\/\*\*/);
  assert.match(out, /tools: write_file/);
  assert.match(out, /--- prompt overlay ---/);
  assert.match(out, /You write docs\./);
});
