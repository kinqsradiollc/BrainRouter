import test from 'node:test';
import assert from 'node:assert/strict';
import { autoTag } from '../cli/commands/track/index.js';

test('Track auto tag identifies work items created by automation only', () => {
  assert.match(autoTag({ activity: [{ actor: 'agent' }] } as any), /auto/);
  assert.match(autoTag({ activity: [{ actor: 'auto' }] } as any), /auto/);
  assert.equal(autoTag({ activity: [{ actor: 'user' }] } as any), '');
  assert.equal(autoTag({ activity: [] } as any), '');
});
