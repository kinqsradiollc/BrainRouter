import test from 'node:test';
import assert from 'node:assert/strict';
import { isOrchestrationToolName, synthesizeDelegateTools } from '../orchestration/tools.js';

/**
 * MAS-P2-M1 — synthesized `delegate_<agentId>` tool tests.
 *
 * The function takes a list of loaded agent definitions (from
 * `agentRegistry.listAll`) and emits one MCP tool descriptor per
 * definition. We test:
 *
 *   1. One tool per def, named after `delegateName` (or
 *      `delegate_<id>` when unset). Description includes the agent's
 *      `whenToUse`.
 *   2. Duplicate `delegateName` is dropped first-write-wins (so a
 *      bad workspace override can't stomp the model's tool list).
 *   3. `isOrchestrationToolName` recognises the synthesized names so
 *      they route through `executeOrchestrationTool` and not into the
 *      "unknown tool" error path.
 *   4. The schema always exposes `prompt` (required) plus the optional
 *      arms the spec calls for (`label`, `access`, `timeoutMs`,
 *      `workdir`, `seedRecordIds`, `ownership`). No silent shape
 *      drift across MAS-P2 versions.
 */

function makeDef(overrides: Partial<{ id: string; delegateName: string; whenToUse: string; defaultAccess: 'read' | 'write' | 'shell' }> = {}) {
  return {
    def: {
      id: overrides.id ?? 'explorer',
      delegateName: overrides.delegateName ?? `delegate_${overrides.id ?? 'explorer'}`,
      whenToUse: overrides.whenToUse ?? 'Read-only investigation.',
      defaultAccess: overrides.defaultAccess ?? 'read',
    },
  };
}

test('synthesizeDelegateTools: emits one tool per agent def with its whenToUse in the description', () => {
  const defs = [
    makeDef({ id: 'explorer', whenToUse: 'Read-only codebase investigation.' }),
    makeDef({ id: 'reviewer', whenToUse: 'Confidence-scored code review.' }),
  ];
  const tools = synthesizeDelegateTools(defs);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'delegate_explorer');
  assert.equal(tools[0].agentId, 'explorer');
  assert.match(tools[0].description, /Read-only codebase investigation/);
  assert.equal(tools[1].name, 'delegate_reviewer');
  assert.match(tools[1].description, /Confidence-scored code review/);
});

test('synthesizeDelegateTools: honours a custom delegateName when set on the def', () => {
  const defs = [makeDef({ id: 'reviewer', delegateName: 'delegate_pr_review' })];
  const tools = synthesizeDelegateTools(defs);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'delegate_pr_review');
});

test('synthesizeDelegateTools: drops duplicates first-write-wins (no shadowing across workspace defs)', () => {
  const defs = [
    makeDef({ id: 'explorer', delegateName: 'delegate_explorer', whenToUse: 'original' }),
    makeDef({ id: 'shadow', delegateName: 'delegate_explorer', whenToUse: 'shadow attempt' }),
    makeDef({ id: 'reviewer', delegateName: 'delegate_reviewer', whenToUse: 'reviewer' }),
  ];
  const tools = synthesizeDelegateTools(defs);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'delegate_explorer');
  assert.match(tools[0].description, /original/);
  assert.equal(tools[1].name, 'delegate_reviewer');
});

test('synthesizeDelegateTools: empty input emits no tools', () => {
  assert.deepEqual(synthesizeDelegateTools([]), []);
});

test('synthesizeDelegateTools: schema exposes prompt + the documented optional arms', () => {
  const [tool] = synthesizeDelegateTools([makeDef({ id: 'worker' })]);
  const props = tool.inputSchema.properties;
  assert.ok(props.prompt);
  assert.ok(props.label);
  assert.ok(props.access);
  assert.ok(props.timeoutMs);
  assert.ok(props.workdir);
  assert.ok(props.seedRecordIds);
  // MAS-P2-M3 ownership constraint surfaces through the tool args so
  // the parent-context snapshot can record it.
  assert.ok(props.ownership);
  assert.deepEqual(tool.inputSchema.required, ['prompt']);
});

test('isOrchestrationToolName: recognises synthesized delegate_<id> names', () => {
  assert.equal(isOrchestrationToolName('delegate_explorer'), true);
  assert.equal(isOrchestrationToolName('delegate_pr_review'), true);
  // Legacy generic stays explicitly listed.
  assert.equal(isOrchestrationToolName('delegate_agent'), true);
  // Non-delegate names route through the existing static set.
  assert.equal(isOrchestrationToolName('spawn_agent'), true);
  assert.equal(isOrchestrationToolName('read_file'), false);
});
